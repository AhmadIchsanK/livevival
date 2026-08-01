// Livevival — imports real matches (not just tournament shells) from each
// tournament page already in the `tournaments` table, using Liquipedia's
// free public API. Also auto-creates a `streams` row from the match's VOD
// link when one is published, and links it via matches.stream_id — so the
// Groq worker has something to watch without any manual step, whenever
// Liquipedia has already posted the link.
//
// How it works: both bracket and group/matchlist views render each match's
// detail into a `.brkts-popup-container.brkts-match-info-popup` block, with
// a consistent structure regardless of tournament format:
//   - .timer-object[data-timestamp][data-finished] — schedule + completion
//   - .match-info-header-opponent(-left) a[title]  — the two team names
//   - .match-info-header-scoreholder-lower          — "(BoX)" format tag
//   - .vodlink a[href]                               — real YouTube VOD links
//
// Respects Liquipedia's API Terms of Use: custom User-Agent, only calls
// api.php (never scrapes a rendered page directly), 2s between requests.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function parseFormat(text) {
  const m = text.match(/Bo(\d)/i);
  if (!m) return null;
  const n = m[1];
  return ["1", "2", "3", "5", "7"].includes(n) ? `BO${n}` : null;
}

function extractMatches(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $(".brkts-popup-container.brkts-match-info-popup").each((_, el) => {
    const $el = $(el);

    const timerEl = $el.find(".timer-object[data-timestamp]").first();
    const timestamp = timerEl.attr("data-timestamp");
    if (!timestamp) return;
    const finished = timerEl.attr("data-finished") === "finished";

    const leftOpponent = $el.find(".match-info-header-opponent.match-info-header-opponent-left").first();
    const rightOpponent = $el
      .find(".match-info-header-opponent")
      .not(".match-info-header-opponent-left")
      .first();

    const teamALink = leftOpponent.find("a[title]").first();
    const teamBLink = rightOpponent.find("a[title]").first();
    const teamAName = teamALink.attr("title");
    const teamBName = teamBLink.attr("title");
    if (!teamAName || !teamBName) return;

    // The anchor's title attribute is the full team name; its visible text
    // is usually the short/abbreviated form Liquipedia's team template
    // displays (e.g. title="RRQ Hoshi", text="RRQ") — capture both.
    const teamAShort = teamALink.text().trim() || null;
    const teamBShort = teamBLink.text().trim() || null;

    const format = parseFormat($el.find(".match-info-header-scoreholder-lower").text());
    const vodHrefs = $el.find(".vodlink a[href]").map((_, a) => $(a).attr("href")).get();

    matches.push({
      teamAName,
      teamBName,
      teamAShort,
      teamBShort,
      timestamp: Number(timestamp),
      finished,
      format,
      youtubeUrl: vodHrefs[0] ?? null,
    });
  });

  return matches;
}

const teamIdCache = new Map();
async function getOrCreateTeamId(name, shortName = null) {
  const key = name.trim().toLowerCase();
  if (teamIdCache.has(key)) return teamIdCache.get(key);

  const { data: existing } = await supabase
    .from("teams")
    .select("id, short_name")
    .ilike("name", name.trim())
    .maybeSingle();

  const resolvedShortName =
    shortName && shortName.toLowerCase() !== name.trim().toLowerCase() && shortName.length <= 10
      ? shortName
      : null;

  if (existing) {
    teamIdCache.set(key, existing.id);
    // Backfill short_name for teams created before this field was captured,
    // or before the short-name fix existed — never overwrite a value that's
    // already set (could be a manual admin edit).
    if (!existing.short_name && resolvedShortName) {
      const { error: updateError } = await supabase
        .from("teams")
        .update({ short_name: resolvedShortName })
        .eq("id", existing.id);
      if (updateError) console.error(`Failed to backfill short_name for "${name}":`, updateError.message);
    }
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("teams")
    .insert({ name: name.trim(), short_name: resolvedShortName })
    .select("id")
    .single();

  if (error) {
    console.error(`Failed to create team "${name}": ${error.message}`);
    return null;
  }
  teamIdCache.set(key, created.id);
  return created.id;
}

async function getOrCreateStream(youtubeUrl, tournamentId, finished) {
  const { data: existing } = await supabase
    .from("streams")
    .select("id")
    .eq("url", youtubeUrl)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("streams")
    .insert({
      url: youtubeUrl,
      tournament_id: tournamentId,
      status: finished ? "ended" : "scheduled",
    })
    .select("id")
    .single();

  if (error) {
    console.error(`Failed to create stream for ${youtubeUrl}: ${error.message}`);
    return null;
  }
  return created.id;
}

async function importMatchesForTournament(tournament) {
  console.log(`Fetching matches for ${tournament.name}...`);
  const html = await fetchRenderedPage(tournament.liquipedia_slug);
  const found = extractMatches(html);
  console.log(`Found ${found.length} matches for ${tournament.name}`);

  for (const m of found) {
    const teamAId = await getOrCreateTeamId(m.teamAName, m.teamAShort);
    const teamBId = await getOrCreateTeamId(m.teamBName, m.teamBShort);
    if (!teamAId || !teamBId) continue;

    const key = `${tournament.liquipedia_slug}__${teamAId}__${teamBId}__${m.timestamp}`;
    const scheduledAt = new Date(m.timestamp * 1000).toISOString();

    let streamId = null;
    if (m.youtubeUrl) {
      streamId = await getOrCreateStream(m.youtubeUrl, tournament.id, m.finished);
    }

    const { data: existing } = await supabase
      .from("matches")
      .select("id, status")
      .eq("liquipedia_match_key", key)
      .maybeSingle();

    const payload = {
      tournament_id: tournament.id,
      team_a_id: teamAId,
      team_b_id: teamBId,
      scheduled_at: scheduledAt,
      liquipedia_match_key: key,
    };
    if (m.format) payload.format = m.format;
    // Only attach a stream if we found one this run — never clobber a
    // manually-linked stream with null just because this pass found nothing.
    if (streamId) payload.stream_id = streamId;

    if (existing) {
      // Never downgrade a match an admin has already put "live" — the
      // worker/admin's own state tracking takes precedence over our re-import.
      if (existing.status !== "live") {
        payload.status = m.finished ? "finished" : existing.status;
      }
      const { error } = await supabase.from("matches").update(payload).eq("id", existing.id);
      if (error) console.error(`Failed to update match: ${error.message}`);
    } else {
      payload.status = m.finished ? "finished" : "scheduled";
      const { error } = await supabase.from("matches").insert(payload);
      if (error) console.error(`Failed to insert match: ${error.message}`);
    }
  }
}

async function main() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h in the past
  const windowEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2h ahead

  // Only touch tournaments that have a match starting soon or that just
  // started — this keeps each run to a handful of requests at most, safe
  // to run frequently, unlike the full scrape which covers everything.
  const { data: imminent, error } = await supabase
    .from("matches")
    .select("tournament_id, tournaments(id, name, liquipedia_slug)")
    .neq("status", "finished")
    .gte("scheduled_at", windowStart)
    .lte("scheduled_at", windowEnd);
  if (error) throw error;

  const uniqueTournaments = new Map();
  for (const m of imminent ?? []) {
    const t = m.tournaments;
    if (t?.liquipedia_slug && !uniqueTournaments.has(t.id)) uniqueTournaments.set(t.id, t);
  }

  console.log(`Refreshing ${uniqueTournaments.size} tournament(s) with imminent matches`);
  for (const t of uniqueTournaments.values()) {
    try {
      await importMatchesForTournament(t);
    } catch (err) {
      console.error(`Failed refreshing ${t.name}:`, err.message);
    }
    await sleep(5000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
