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
// IMPORTANT — multi-page tournaments: many tournaments (confirmed for every
// MPL national league, at least Season 16 onward) split their bracket across
// *subpages* instead of rendering it inline on the tournament's own page —
// e.g. "MPL/Indonesia/Season_18" itself has ZERO match popups; the 72 real
// group-stage matches live on "MPL/Indonesia/Season_18/Regular_Season", a
// separate wiki page. This was confirmed against real rendered HTML (not
// guessed) via a throwaway diagnostic GH Actions run: the tournament's own
// page linked to "/Regular_Season" and "/Statistics" subpages, and only
// "/Regular_Season" had any `.brkts-popup-container` blocks. This wasn't a
// new-tournament-only gap either — Season 16/17 (already "working") were
// silently stuck at 8 matches each (just the small inline playoffs bracket)
// the entire time, because this importer only ever fetched
// `tournament.liquipedia_slug` and never looked for subpages at all.
//
// Fix: for every tournament, ask the API which subpages exist under its
// slug (MediaWiki's allpages, prefix-matched — not a hardcoded list of
// subpage names, so a tournament that later gains a "/Playoffs" or
// "/Group_Stage" subpage picks it up automatically too) and fetch matches
// from the base page plus every subpage found, merging results. See
// getTournamentPages() below.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent, only calls
// api.php (never scrapes a rendered page directly), 2s between requests.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, apiQuery, sleep, sortByLifecyclePriority, tournamentPriorityRank } from "./_liquipedia.mjs";

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

// Exported so scripts/backfill-match-stage.mjs can re-derive the exact same
// match list (and stage) per page without duplicating this parsing.
export function extractMatches(html) {
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

// Discovers every wiki subpage nested under a tournament's own slug (e.g.
// "MPL/Indonesia/Season_18/Regular_Season", "…/Statistics") via MediaWiki's
// allpages, prefix-matched against the tournament's slug — not a hardcoded
// list of subpage names, so this generalizes to whatever subpage structure
// a tournament (current or future) actually uses instead of only covering
// today's known "Regular_Season"/"Playoffs" naming.
//
// allpages returns titles with spaces (MediaWiki's display form) even
// though slugs are stored with underscores — normalized back to underscores
// here so they're directly usable with fetchRenderedPage/liquipedia_slug
// elsewhere in this file.
//
// "/Statistics" (and its own nested subpages, e.g. ".../Statistics/Playoffs")
// is the one subpage type confirmed to never contain match popups — a
// per-player/per-hero stats page, not a bracket — so it's excluded to avoid
// spending a request on a page that structurally can't have what we want.
// Exported so scripts/backfill-match-stage.mjs can enumerate the same pages
// instead of duplicating subpage discovery.
export async function getTournamentPages(tournament) {
  const baseSlug = tournament.liquipedia_slug;
  const pages = [baseSlug];
  try {
    const data = await apiQuery({ action: "query", list: "allpages", apprefix: baseSlug, aplimit: "50" });
    const subpages = (data?.query?.allpages ?? [])
      .map((p) => p.title.replace(/ /g, "_"))
      .filter((title) => title !== baseSlug && title.startsWith(`${baseSlug}/`))
      .filter((title) => !/\/Statistics(\/|$)/i.test(title));
    pages.push(...subpages);
  } catch (err) {
    console.warn(`Could not discover subpages for ${tournament.name}: ${err.message} (falling back to base page only)`);
  }
  return pages;
}

// Best-effort stage label derived from the subpage a match's popup was
// found on (e.g. ".../Regular_Season" -> "Regular Season", ".../Playoffs"
// -> "Playoffs") — the same subpage names getTournamentPages() already
// discovers to know where to look for matches at all, so tagging each
// match with the page it came from is nearly free. The tournament's own
// base page (pages[0]) carries no stage info of its own (a flat schedule,
// a bracket overview, or just duplicates of the subpages) so it's left
// null rather than guessed at.
// Exported so scripts/backfill-match-stage.mjs can derive the same stage
// label for the one-time backfill of rows that predate this column.
export function deriveStageFromPage(baseSlug, pageSlug) {
  if (pageSlug === baseSlug) return null;
  const lastSegment = pageSlug.slice(baseSlug.length + 1).split("/").pop();
  if (!lastSegment) return null;
  return lastSegment.replace(/_/g, " ");
}

async function importMatchesForTournament(tournament) {
  const pages = await getTournamentPages(tournament);
  console.log(`Fetching matches for ${tournament.name} across ${pages.length} page(s): ${pages.join(", ")}`);

  const found = [];
  let allPagesOk = true;
  for (let i = 0; i < pages.length; i++) {
    try {
      const html = await fetchRenderedPage(pages[i]);
      const stage = deriveStageFromPage(tournament.liquipedia_slug, pages[i]);
      found.push(...extractMatches(html).map((m) => ({ ...m, stage })));
    } catch (err) {
      console.error(`Failed fetching "${pages[i]}" for ${tournament.name}: ${err.message}`);
      allPagesOk = false;
    }
    if (i < pages.length - 1) await sleep(2000); // extra headroom beyond the documented 1 req/2s
  }
  console.log(`Found ${found.length} matches for ${tournament.name}`);

  // Every match key seen on Liquipedia THIS run — used below to reconcile away
  // rows that have vanished from the bracket (a predicted pairing that changed,
  // or a rescheduled match whose timestamp moved). A row's key embeds the two
  // team ids + the timestamp, so any such change mints a NEW row and orphans the
  // old one, which then never gets a status update again and sits on "live"
  // forever. Collecting the live set lets us delete those orphans.
  const seenKeys = new Set();
  let teamResolveFailed = false;

  for (const m of found) {
    const teamAId = await getOrCreateTeamId(m.teamAName);
    const teamBId = await getOrCreateTeamId(m.teamBName);
    if (!teamAId || !teamBId) {
      teamResolveFailed = true; // incomplete key set — don't reconcile-delete below
      continue;
    }

    const key = `${tournament.liquipedia_slug}__${teamAId}__${teamBId}__${m.timestamp}`;
    seenKeys.add(key);
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
      // A FINISHED result from Liquipedia always applies — even to a match
      // currently marked "live". This is the auto-finish path: without it a
      // match promoted to "live" on schedule (by /api/cron/match-lifecycle)
      // stayed "live" forever, because the old guard skipped the status update
      // entirely whenever the row was already "live" — so a real, completed
      // result never landed. For a match that is NOT yet finished, we still
      // never downgrade a "live" row back to "scheduled" (an admin/worker may
      // have put it live ahead of Liquipedia flipping its own flag).
      if (m.finished) {
        payload.status = "finished";
      } else if (existing.status !== "live") {
        payload.status = existing.status;
      }
      // Stage is intentionally NOT set on update, even when this pass
      // derived one — same reasoning as stream_id above: an admin may have
      // hand-edited it (e.g. to something more specific than the raw
      // subpage name), and a re-import shouldn't silently clobber that.
      // Every match row that predates this column falls into this branch
      // forever (they already exist, so they're always an update, never an
      // insert) and so never gets a stage from this script by design — see
      // scripts/backfill-match-stage.mjs for the one-time pass that closes
      // that gap (only filling rows still null, same non-clobber rule).
      const { error } = await supabase.from("matches").update(payload).eq("id", existing.id);
      if (error) console.error(`Failed to update match: ${error.message}`);
    } else {
      payload.status = m.finished ? "finished" : "scheduled";
      if (m.stage) payload.stage = m.stage;
      const { error } = await supabase.from("matches").insert(payload);
      if (error) console.error(`Failed to insert match: ${error.message}`);
    }
  }

  // ── Reconcile orphans ─────────────────────────────────────────────────
  // Delete this tournament's not-yet-played rows that no longer exist on
  // Liquipedia — the predicted-pairing / rescheduled leftovers that otherwise
  // stay stuck on "live" forever (confirmed in production: a bracket whose
  // seeded "Rune Eaters vs Team Yandex" became "Omnix vs Team Yandex" left the
  // first as a phantom live row; a rescheduled MSL match left its old timeslot
  // orphaned the same way). Guards so this can NEVER remove a real match:
  //   • only run when every page fetched cleanly AND every team resolved AND we
  //     actually found matches — a partial parse must not look like "everything
  //     vanished";
  //   • only rows whose key wasn't seen on Liquipedia this run;
  //   • only status live/scheduled (never a finished match);
  //   • only rows with ZERO games logged (a real played match is never touched);
  //   • only rows already stale (>6h past their start) so a genuinely-upcoming
  //     match momentarily missing from a parse isn't removed.
  if (allPagesOk && !teamResolveFailed && found.length > 0) {
    const staleCutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: candidates, error: selErr } = await supabase
      .from("matches")
      .select("id, liquipedia_match_key, scheduled_at")
      .eq("tournament_id", tournament.id)
      .eq("update_source", "liquipedia")
      .in("status", ["live", "scheduled"])
      .lt("scheduled_at", staleCutoff);
    if (selErr) {
      console.error(`Orphan reconcile query failed for ${tournament.name}: ${selErr.message}`);
    } else {
      for (const c of candidates ?? []) {
        if (!c.liquipedia_match_key || seenKeys.has(c.liquipedia_match_key)) continue; // still on Liquipedia
        const { count } = await supabase.from("games").select("id", { count: "exact", head: true }).eq("match_id", c.id);
        if ((count ?? 0) > 0) continue; // has real game data — keep
        const { error: delErr } = await supabase.from("matches").delete().eq("id", c.id);
        if (delErr) console.error(`Failed to delete orphan ${c.id}: ${delErr.message}`);
        else console.log(`Deleted orphan match (no longer on Liquipedia): ${c.liquipedia_match_key}`);
      }
    }
  }
}

// Rolling 1-year window (not calendar year) — see import-liquipedia.mjs for
// why a string match on the current year silently drops tournaments that
// started in a prior calendar year but are still within the past 12 months.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
function isWithinPastYear(startDate, endDate) {
  if (!startDate && !endDate) return false;
  if (!endDate) return true; // ongoing/TBD finish — can't be stale
  return new Date(endDate).getTime() >= Date.now() - ONE_YEAR_MS;
}

async function main() {
  const { data: tournaments, error } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug, date_display, start_date, end_date");
  if (error) throw error;

  // Optional manual override: TOURNAMENT_SLUGS="MPL/Indonesia/Season_18,..."
  // re-imports just those tournaments, bypassing both the past-year window
  // and table order entirely. Added after a real case where a handful of
  // tournaments happened to sit late enough in table order that this job's
  // timeout was reached before ever getting to them, run after run — even
  // with the subpage-discovery fix (which adds real per-tournament runtime)
  // and a raised timeout, a large enough tournament list at Liquipedia's
  // rate-limit pacing can still not fit everything in one pass. Lets an
  // admin (or a one-off manual dispatch) target exactly the tournament(s)
  // that need to land right now instead of waiting on/hoping a full pass
  // reaches them before it runs out of time.
  const override = (process.env.TOURNAMENT_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filtered =
    override.length > 0
      ? (tournaments ?? []).filter((t) => override.includes(t.liquipedia_slug))
      : (tournaments ?? []).filter((t) => t.liquipedia_slug && isWithinPastYear(t.start_date, t.end_date));

  // Ongoing first, then imminent-upcoming, then most-recently-completed — so a
  // run that gets cancelled at its timeout has still updated the tournaments
  // whose results/streams are actually changing now, instead of burning the
  // budget on years-old history that never reaches the current season.
  let relevant = sortByLifecyclePriority(filtered);

  // ONGOING_ONLY=1 restricts the pass to tournaments running RIGHT NOW (started,
  // not yet ended). This is the fast, cheap sync meant to run frequently (hourly)
  // so a live match flips to "finished" within ~an hour of its result landing on
  // Liquipedia — instead of waiting up to 6h for the full pass. The full 6-hourly
  // pass (no flag) still covers upcoming + recent history. Ignored when an
  // explicit TOURNAMENT_SLUGS override is given.
  const ongoingOnly = override.length === 0 && /^(1|true|yes)$/i.test(process.env.ONGOING_ONLY ?? "");
  if (ongoingOnly) {
    relevant = relevant.filter((t) => tournamentPriorityRank(t) === 0);
  }

  console.log(
    override.length > 0
      ? `TOURNAMENT_SLUGS override: processing ${relevant.length} of ${override.length} explicitly requested tournament(s)`
      : ongoingOnly
        ? `ONGOING_ONLY: processing ${relevant.length} currently-running tournament(s)`
        : `Processing ${relevant.length} of ${tournaments?.length ?? 0} tournaments (ongoing first, then upcoming, then recent)`
  );

  for (const t of relevant) {
    try {
      await importMatchesForTournament(t);
    } catch (err) {
      console.error(`Failed importing matches for ${t.name}:`, err.message);
    }
    await sleep(5000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
