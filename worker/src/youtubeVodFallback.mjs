// Fallback per-game VOD source: when Liquipedia has no "Watch Game N" link
// for a finished game, search the official MLBB eSports YouTube channel
// (@mlbbesportsofficial) for a matching upload instead. This is the
// fallback the owner offered as optional ("or we can always check the
// MLBB official channel"), not the primary source — Liquipedia's own
// per-game VOD links (finishedMatchSync.mjs) and the whole-stream fallback
// (already on the public match page) both take priority; this only fills
// games that still have no vod_url after those.
//
// No-ops (with a one-time console note) when YOUTUBE_API_KEY isn't set, so
// it's safe to call unconditionally without breaking deployments that
// haven't configured a key yet.
//
// Gated to run at most once per hour (module-level timestamp, not a DB
// column) since search.list costs 100 of the free tier's 10,000 daily
// quota units per call — this is a background check, not a per-tick
// lookup. Matches the "check every 1 hour" cadence from the original spec.

import { supabase } from "./config.mjs";

const CHANNEL_ID = "UCMncR-XXNXhMyJELEgCrHlg"; // MLBB eSports (@mlbbesportsofficial), confirmed via channels.list
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_AGE_DAYS = 14; // bound how far back the backlog scan looks each run

let lastRunAt = 0;
let warnedMissingKey = false;

function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function searchChannel(query, apiKey) {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("channelId", CHANNEL_ID);
  url.searchParams.set("q", query);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "date");
  url.searchParams.set("maxResults", "10");

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`YouTube search failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return data.items ?? [];
}

// Requires both team names AND a "Game N" mention in the title — a plain
// "vs" search on a busy esports channel returns unrelated videos (shorts,
// highlight reels, full-VOD uploads covering every game at once) far more
// often than it returns the exact per-game upload, so this stays
// conservative and leaves vod_url null rather than link the wrong video.
function findMatchingVideo(items, teamAName, teamBName, gameNumber) {
  const a = normalize(teamAName);
  const b = normalize(teamBName);
  const gamePattern = new RegExp(`game\\s*${gameNumber}\\b`, "i");

  for (const item of items) {
    const title = item.snippet?.title ?? "";
    if (normalize(title).includes(a) && normalize(title).includes(b) && gamePattern.test(title)) {
      return item.id?.videoId ?? null;
    }
  }
  return null;
}

export async function maybeFillMissingVodsFromYoutube() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.log("YouTube VOD fallback not configured (YOUTUBE_API_KEY unset) — skipping.");
      warnedMissingKey = true;
    }
    return;
  }

  const now = Date.now();
  if (now - lastRunAt < CHECK_INTERVAL_MS) return;
  lastRunAt = now;

  const sinceCutoff = new Date(now - MAX_AGE_DAYS * 24 * 3600_000).toISOString();
  const { data: games, error: gamesError } = await supabase
    .from("games")
    .select("id, game_number, match_id")
    .eq("status", "finished")
    .is("vod_url", null)
    .gte("finished_at", sinceCutoff);
  if (gamesError) {
    console.error("Failed to load games missing VOD:", gamesError.message);
    return;
  }
  if (!games || games.length === 0) return;

  const matchIds = [...new Set(games.map((g) => g.match_id))];
  const { data: matches, error: matchesError } = await supabase
    .from("matches")
    .select("id, team_a_id, team_b_id")
    .in("id", matchIds);
  if (matchesError) {
    console.error("Failed to load matches for VOD fallback:", matchesError.message);
    return;
  }
  const matchById = new Map((matches ?? []).map((m) => [m.id, m]));

  const teamIds = [...new Set((matches ?? []).flatMap((m) => [m.team_a_id, m.team_b_id]).filter(Boolean))];
  const { data: teams, error: teamsError } = await supabase.from("teams").select("id, name").in("id", teamIds);
  if (teamsError) {
    console.error("Failed to load teams for VOD fallback:", teamsError.message);
    return;
  }
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, t.name]));

  console.log(`Checking MLBB YouTube channel for ${games.length} missing per-game VOD(s)...`);

  for (const g of games) {
    const match = matchById.get(g.match_id);
    const teamA = match && teamNameById.get(match.team_a_id);
    const teamB = match && teamNameById.get(match.team_b_id);
    if (!teamA || !teamB) continue;

    try {
      const items = await searchChannel(`${teamA} vs ${teamB}`, apiKey);
      const videoId = findMatchingVideo(items, teamA, teamB, g.game_number);
      if (videoId) {
        const { error: updateError } = await supabase
          .from("games")
          .update({ vod_url: `https://www.youtube.com/watch?v=${videoId}` })
          .eq("id", g.id);
        if (updateError) console.error(`Failed to set VOD for game ${g.id}:`, updateError.message);
        else console.log(`Found YouTube VOD for game ${g.id} (${teamA} vs ${teamB}, Game ${g.game_number})`);
      }
    } catch (err) {
      console.error(`YouTube lookup failed for game ${g.id}:`, err.message);
    }
  }
}
