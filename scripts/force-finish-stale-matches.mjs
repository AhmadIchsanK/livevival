// Livevival — force-finishes a Liquipedia-sourced match that's sat
// non-finished implausibly long (Liquipedia never flipped its finished
// flag — human error on the wiki, a page edit that dropped the popup,
// etc.), so it would otherwise show as "live" on the public site forever
// with no result.
//
// Ported from worker/src/staleMatchSync.mjs (deleted along with the rest
// of the always-on Railway worker — see MIGRATION_REMOVE_RAILWAY.md — that
// process no longer exists to run this on its own 10-min tick). This is
// the same logic, re-run periodically via GitHub Actions cron instead:
// query is identical, and refreshing a stale match's tournament before
// giving up now goes through import-finished-match-details.mjs's
// importTournament() (the same function refresh-ongoing-tournament-
// matches.mjs already uses) rather than the worker's own
// syncTournamentFinishedMatches.
//
// Per-format max duration, worked from the admin's own estimate: a single
// game (draft through game finish) takes up to ~1 hour, plus ~10 minutes
// of overhead per game for the post-game screen and next draft to start
// (GAME_OVERHEAD_HOURS), times the maximum possible games in the format,
// plus a flat 2-hour buffer for delays/technical pauses. For BO3 that's
// 3*(1 + 1/6) + 2 = 5.5, rounded up to 6 hours — matching the number the
// admin gave directly; every other format is the same formula scaled by
// its own max game count, rounded up to a whole hour (BO1=4h, BO3=6h,
// BO5=8h, BO7=11h).
import { createClient } from "@supabase/supabase-js";
import { importTournament } from "./import-finished-match-details.mjs";
import { discoverStagePages } from "./refresh-finished-match-details.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GAME_MAX_HOURS = 1;
const GAME_OVERHEAD_HOURS = 1 / 6;
const DELAY_BUFFER_HOURS = 2;
const MAX_GAMES_BY_FORMAT = { BO1: 1, BO2: 2, BO3: 3, BO5: 5, BO7: 7 };
// A handful of matches predate the format column being reliably populated
// — BO3 is this scraper's most common format, so it's the least-wrong
// default for a match with no format on record.
const DEFAULT_MAX_GAMES = MAX_GAMES_BY_FORMAT.BO3;

export function thresholdHours(format) {
  const maxGames = MAX_GAMES_BY_FORMAT[format] ?? DEFAULT_MAX_GAMES;
  return Math.ceil(maxGames * (GAME_MAX_HOURS + GAME_OVERHEAD_HOURS) + DELAY_BUFFER_HOURS);
}

export async function findStaleMatches() {
  const { data, error } = await supabase
    .from("matches")
    .select("id, format, scheduled_at, tournament_id, tournaments(id, name, liquipedia_slug)")
    .eq("update_source", "liquipedia")
    .neq("status", "finished");
  if (error) {
    console.error("Failed to load matches for stale-match check:", error.message);
    return [];
  }

  const now = Date.now();
  return (data ?? []).filter((m) => {
    if (!m.scheduled_at || !m.tournaments?.liquipedia_slug) return false;
    const ageHours = (now - new Date(m.scheduled_at).getTime()) / 3600_000;
    return ageHours > thresholdHours(m.format);
  });
}

async function refreshTournamentFinishedMatches(tournament) {
  const pages = [tournament.liquipedia_slug, ...(await discoverStagePages(tournament.liquipedia_slug))];
  for (const page of pages) {
    await importTournament(page, tournament.id);
  }
}

async function main() {
  const stale = await findStaleMatches();
  if (stale.length === 0) {
    console.log("No stale matches past their format's max duration.");
    return;
  }
  console.log(`Stale-match sweep: ${stale.length} match(es) past their format's max duration.`);

  const tournamentsById = new Map();
  for (const m of stale) tournamentsById.set(m.tournament_id, m.tournaments);

  for (const tournament of tournamentsById.values()) {
    try {
      await refreshTournamentFinishedMatches(tournament);
    } catch (err) {
      console.error(`Stale-match refresh failed for ${tournament.name}:`, err.message);
    }
  }

  const { data: stillOpen } = await supabase
    .from("matches")
    .select("id, format")
    .in("id", stale.map((m) => m.id))
    .neq("status", "finished");

  for (const m of stillOpen ?? []) {
    const hours = thresholdHours(m.format);
    const { error } = await supabase
      .from("matches")
      .update({
        status: "finished",
        custom_state_label: `Auto-closed after ${hours}h — no Liquipedia result yet`,
      })
      .eq("id", m.id);
    if (error) console.error(`Failed to force-finish match ${m.id}:`, error.message);
    else console.warn(`Force-finished match ${m.id} after ${hours}h with no confirmed result.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
