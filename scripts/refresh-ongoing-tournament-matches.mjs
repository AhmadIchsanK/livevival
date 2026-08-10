// Livevival — closes a gap between the always-on worker (which only
// updates matches that already have a DB row) and the 6h full importer
// (which discovers new matches, but can be hours late for a specific
// tournament — either because it sits late in table order and the job
// times out before reaching it, or because it simply hasn't run yet).
//
// Concretely: a bracket page gains new match popups over the course of a
// live tournament (e.g. the Grand Final only appears once the semifinals
// resolve) — worker/'s scheduleSync.mjs deliberately skips creating rows
// for matches it doesn't already know about ("new matches are picked up by
// the 6h full importer"), so a currently-ongoing tournament can go most of
// a day without its newest matches ever reaching the database. Confirmed
// as exactly why Games of the Future 2026's Grand Final never synced: the
// tournament's last known match was two days before the final actually
// played.
//
// This runs every 30 minutes (see the paired workflow) and re-imports
// matches for ONLY tournaments currently in progress — normally 0-3 at
// once — reusing import-liquipedia-matches.mjs's exact fetch/upsert logic
// so new matches, not just status updates on existing ones, land quickly
// without waiting on the slower 6h pass.
//
// It also runs the finished-match-details importer (games/picks/bans/
// winner) for the same tournaments, not just the schedule importer. These
// are two genuinely separate systems — import-liquipedia-matches.mjs only
// ever writes status/format/stream_id, never games/hero_picks_bans/
// series_winner_team_id/state — and those detail fields normally get
// filled in later by the worker's live-window poll or the 6h
// refresh-finished-match-details.mjs cron. Both of those miss a match
// that's discovered ALREADY finished: the worker only polls matches whose
// scheduled_at is within a few hours of now, and a match found for the
// first time a day after it aired is already outside that window the
// instant its row is created. Confirmed as exactly what happened to Games
// of the Future 2026's Grand Final — it landed with status='finished' but
// zero games, zero picks/bans, and state stuck at MATCH_NOT_STARTED,
// because nothing had ever run the detail import against it. Running both
// importers together here means a late-discovered match gets its full
// result in the same 30-min cycle it's discovered in, instead of
// depending on a second, differently-scoped process to ever reach it.
// Also runs the final-standings importer (placement/prize table) for the
// same tournaments — same reasoning as the detail importer above: a
// tournament whose last known match was already finished when discovered
// falls straight out of the 6h cron's "past year" window logic having ever
// run against it in time, and its final rank/placement (tournament_results)
// never gets populated any other way.
import { createClient } from "@supabase/supabase-js";
import { importMatchesForTournament } from "./import-liquipedia-matches.mjs";
import { importTournament } from "./import-finished-match-details.mjs";
import { importTournamentResults } from "./import-tournament-results.mjs";
import { discoverStagePages } from "./refresh-finished-match-details.mjs";
import { sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A tournament's own end_date is the last scheduled day, not necessarily
// the last moment a bracket popup could still change (Liquipedia edits
// sometimes lag the actual broadcast by a few hours) — one extra day of
// grace after end_date keeps a tournament in this fast lane through the
// day after it wraps, same idea as worker/'s recentWindowHours.
const END_DATE_GRACE_DAYS = 1;

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const graceCutoff = new Date(Date.now() - END_DATE_GRACE_DAYS * 86400_000).toISOString().slice(0, 10);

  const { data: tournaments, error } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug, start_date, end_date")
    .not("liquipedia_slug", "is", null)
    .not("start_date", "is", null)
    .lte("start_date", todayIso);
  if (error) throw error;

  const ongoing = (tournaments ?? []).filter((t) => !t.end_date || t.end_date >= graceCutoff);

  if (ongoing.length === 0) {
    console.log("No currently-ongoing tournaments to refresh.");
    return;
  }
  console.log(`Refreshing ${ongoing.length} ongoing tournament(s): ${ongoing.map((t) => t.name).join(", ")}`);

  for (const t of ongoing) {
    try {
      await importMatchesForTournament(t);
    } catch (err) {
      console.error(`Failed importing matches for ${t.name}:`, err.message);
    }
    await sleep(5000); // same inter-tournament pacing as import-liquipedia-matches.mjs

    try {
      const pages = [t.liquipedia_slug, ...(await discoverStagePages(t.liquipedia_slug))];
      for (const page of pages) {
        await importTournament(page, t.id);
        await sleep(5000);
      }
    } catch (err) {
      console.error(`Failed importing match details for ${t.name}:`, err.message);
    }

    try {
      await importTournamentResults(t.liquipedia_slug);
    } catch (err) {
      console.error(`Failed importing standings for ${t.name}:`, err.message);
    }
    await sleep(4000); // same pacing refresh-finished-match-details.mjs uses after this same call
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
