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

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";

// TODO: same as the tournament importer — put a real contact email here.
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: YOUR_EMAIL_HERE)";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRenderedPage(pageTitle, attempt = 1) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });

  if (res.status === 429 && attempt <= 3) {
    const waitMs = 15000 * attempt; // back off harder each retry
    console.warn(`Rate limited on ${pageTitle}, waiting ${waitMs / 1000}s before retry ${attempt}/3...`);
    await sleep(waitMs);
    return fetchRenderedPage(pageTitle, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);
  }
  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}

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

    const teamAName = leftOpponent.find("a[title]").first().attr("title");
    const teamBName = rightOpponent.find("a[title]").first().attr("title");
    if (!teamAName || !teamBName) return;

    const format = parseFormat($el.find(".match-info-header-scoreholder-lower").text());
    const vodHrefs = $el.find(".vodlink a[href]").map((_, a) => $(a).attr("href")).get();

    matches.push({
      teamAName,
      teamBName,
      timestamp: Number(timestamp),
      finished,
      format,
      youtubeUrl: vodHrefs[0] ?? null,
    });
  });

  return matches;
}

const teamIdCache = new Map();
async function getOrCreateTeamId(name) {
  const key = name.trim().toLowerCase();
  if (teamIdCache.has(key)) return teamIdCache.get(key);

  const { data: existing } = await supabase
    .from("teams")
    .select("id")
    .ilike("name", name.trim())
    .maybeSingle();

  if (existing) {
    teamIdCache.set(key, existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from("teams")
    .insert({ name: name.trim() })
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
    const teamAId = await getOrCreateTeamId(m.teamAName);
    const teamBId = await getOrCreateTeamId(m.teamBName);
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

// One pass: refresh every tournament that has a match starting soon or
// recently started, then report back whether any match that SHOULD be live
// by now (per its recorded schedule time) still has no stream attached —
// i.e. Liquipedia hasn't published the VOD/livestream link yet.
async function runOnce() {
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
    await sleep(3000);
  }

  // A match "should be live" once its scheduled_at has passed, with a
  // little grace on both sides: Liquipedia's posted time can be a few
  // minutes off from when a stream actually starts, and cast delays are
  // common. If it's in that window and still has no stream_id, Liquipedia
  // likely hasn't published the VOD/livestream link yet.
  const dueSince = new Date(now.getTime() - 15 * 60 * 1000).toISOString(); // up to 15 min overdue
  const dueBy = new Date(now.getTime() + 2 * 60 * 1000).toISOString(); // or starting within 2 min
  const { data: stillMissing } = await supabase
    .from("matches")
    .select("id")
    .neq("status", "finished")
    .is("stream_id", null)
    .gte("scheduled_at", dueSince)
    .lte("scheduled_at", dueBy);

  return (stillMissing ?? []).length > 0;
}

// GitHub Actions cron can't reliably go tighter than ~5 minutes, so instead
// of relying on cron granularity, one invocation of this script (triggered
// every 10 minutes as normal) manages its own tighter retry loop internally
// whenever a match is due to be live and still has no stream: recheck every
// 2 minutes, capped so this run finishes before the *next* scheduled cron
// run would start anyway.
const TIGHT_RETRY_INTERVAL_MS = 2 * 60 * 1000;
const TIGHT_RETRY_MAX_ATTEMPTS = 4; // ~8 extra minutes, safely under the 10-minute cron gap

async function main() {
  let stillMissing = await runOnce();

  let attempt = 0;
  while (stillMissing && attempt < TIGHT_RETRY_MAX_ATTEMPTS) {
    attempt += 1;
    console.log(
      `A match is due to be live with no stream yet — rechecking in 2 minutes (attempt ${attempt}/${TIGHT_RETRY_MAX_ATTEMPTS})...`
    );
    await sleep(TIGHT_RETRY_INTERVAL_MS);
    stillMissing = await runOnce();
  }

  if (stillMissing) {
    console.log("Still no stream found after tight retries — the normal 10-minute cron will pick it up next.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
