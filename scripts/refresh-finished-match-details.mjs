// Livevival — runs the finished-match-details and tournament-results
// importers automatically across every current-year tournament, instead of
// requiring a manual `node script.mjs "<page>"` call per tournament (which
// is why neither script had actually populated anything yet).
//
// Stage subpages: picks/bans/VODs for a bracket usually live on subpages
// like "MSC/2026/Group_Stage" or "MSC/2026/Knockout_Stage", not always the
// top-level tournament page. We discover these automatically by scanning
// the top-level page's rendered HTML for internal links that start with
// "/mobilelegends/<this tournament's slug>/" — no hardcoded subpage names.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { importTournament } from "./import-finished-match-details.mjs";
import { importTournamentResults } from "./import-tournament-results.mjs";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function discoverStagePages(tournamentSlug) {
  const html = await fetchRenderedPage(tournamentSlug);
  const $ = cheerio.load(html);

  const prefix = `/mobilelegends/${tournamentSlug}/`;
  const subpages = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (href.startsWith(prefix)) {
      const decoded = decodeURIComponent(href.replace("/mobilelegends/", ""));
      const clean = decoded.split("#")[0].split("?")[0];
      const remainder = clean.slice(tournamentSlug.length + 1); // strip "MSC/2026/"
      // Only keep direct child pages (one level deep), skip grandchildren.
      if (remainder && !remainder.includes("/")) {
        subpages.add(clean);
      }
    }
  });

  return Array.from(subpages);
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
  // processes just those tournaments, bypassing both the past-year window and
  // table order entirely — same fix already applied to
  // import-liquipedia-matches.mjs for the identical failure mode. Confirmed
  // via job logs (runs cancelled/interrupted well before finishing a full
  // pass, repeatedly) that this script's fixed table-order, no-resume-state
  // walk over ~150 tournaments means whichever ones sit late in the list
  // effectively never get their finished-match details (games/picks/
  // bans/VODs) populated, run after run — e.g. every MPL national league's
  // most recent 1-2 seasons sat at 0 games rows for dozens of already-
  // finished matches despite the matches themselves importing fine. Lets a
  // one-off manual dispatch target exactly the tournament(s) that need to
  // land right now instead of waiting on/hoping a full pass reaches them.
  const override = (process.env.TOURNAMENT_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const relevant =
    override.length > 0
      ? (tournaments ?? []).filter((t) => override.includes(t.liquipedia_slug))
      : (tournaments ?? []).filter((t) => t.liquipedia_slug && isWithinPastYear(t.start_date, t.end_date));

  console.log(
    override.length > 0
      ? `TOURNAMENT_SLUGS override: processing ${relevant.length} of ${override.length} explicitly requested tournament(s)`
      : `Processing finished-match details + results for ${relevant.length} tournament(s) (past year, or upcoming/ongoing)`
  );

  for (const t of relevant) {
    try {
      console.log(`\n=== ${t.name} (${t.liquipedia_slug}) ===`);

      // Final standings live on the top-level page.
      await importTournamentResults(t.liquipedia_slug);
      await sleep(4000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs

      // Picks/bans/VODs can be on the top-level page OR on stage subpages —
      // try both so tournaments using either layout are covered.
      const pagesToCheck = [t.liquipedia_slug, ...(await discoverStagePages(t.liquipedia_slug))];
      console.log(`Checking ${pagesToCheck.length} page(s) for match details: ${pagesToCheck.join(", ")}`);

      for (const page of pagesToCheck) {
        // Pass t.id directly — see import-finished-match-details.mjs's
        // importTournament() header comment for why relying on it to
        // re-resolve a stage subpage's tournament by exact slug match
        // silently skipped every subpage (the bug that left most
        // multi-page tournaments' finished matches without games rows).
        await importTournament(page, t.id);
        await sleep(5000);
      }
    } catch (err) {
      console.error(`Failed processing ${t.name}:`, err.message);
    }
  }
}

// Guarded so refresh-ongoing-tournament-matches.mjs can import
// discoverStagePages without also triggering this file's own unscoped
// full-tournament-list main() as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
