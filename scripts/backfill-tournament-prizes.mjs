// Livevival — one-time backfill: re-scrapes the prizepool table for any
// finished tournament where NONE of its stored placement rows have a
// prize_usd value.
//
// This is a different gap from the tied-placement one (a rowspan'd
// placement cell leaving only sibling rows null, already handled at
// render time in app/tournaments/[...slug]/page.tsx). Confirmed via a
// direct query that a handful of tournaments (e.g. MPL Singapore Season
// 11) have EVERY placement row's prize_usd null — the scraper found the
// table and the team names, but never captured a dollar figure at all.
// Re-running import-tournament-results.mjs's existing extractor picks up
// whatever Liquipedia's page actually has today; if a tournament's page
// genuinely has no published prize pool (unannounced or a non-cash
// regional league), the re-scrape will still show zero and that's a real
// "Liquipedia has no data" case, not a script bug — this script just makes
// sure we're not reporting stale zeros from a transient scrape failure.
//
// Safe to re-run: importTournamentResults() upserts on
// (tournament_id, placement, team_name_raw), so re-running never
// duplicates rows.

import { createClient } from "@supabase/supabase-js";
import { sleep } from "./_liquipedia.mjs";
import { importTournamentResults } from "./import-tournament-results.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const { data: tournaments, error } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug")
    .not("liquipedia_slug", "is", null);
  if (error) throw error;

  const { data: results, error: resultsError } = await supabase
    .from("tournament_results")
    .select("tournament_id, prize_usd");
  if (resultsError) throw resultsError;

  const hasAnyPrize = new Set(results.filter((r) => r.prize_usd != null).map((r) => r.tournament_id));
  const hasAnyRow = new Set(results.map((r) => r.tournament_id));

  const targets = tournaments.filter((t) => hasAnyRow.has(t.id) && !hasAnyPrize.has(t.id));
  console.log(`${targets.length} tournament(s) with placement rows but zero prize data`);

  for (const t of targets) {
    try {
      await importTournamentResults(t.liquipedia_slug);
    } catch (err) {
      console.error(`Failed processing "${t.name}":`, err.message);
    }
    await sleep(4000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
