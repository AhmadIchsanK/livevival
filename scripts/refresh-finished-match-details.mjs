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

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRenderedPage(pageTitle) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);
  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}

async function discoverStagePages(tournamentSlug) {
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

  const relevant = (tournaments ?? []).filter(
    (t) => t.liquipedia_slug && isWithinPastYear(t.start_date, t.end_date)
  );
  console.log(`Processing finished-match details + results for ${relevant.length} tournament(s) (past year, or upcoming/ongoing)`);

  for (const t of relevant) {
    try {
      console.log(`\n=== ${t.name} (${t.liquipedia_slug}) ===`);

      // Final standings live on the top-level page.
      await importTournamentResults(t.liquipedia_slug);
      await sleep(2000);

      // Picks/bans/VODs can be on the top-level page OR on stage subpages —
      // try both so tournaments using either layout are covered.
      const pagesToCheck = [t.liquipedia_slug, ...(await discoverStagePages(t.liquipedia_slug))];
      console.log(`Checking ${pagesToCheck.length} page(s) for match details: ${pagesToCheck.join(", ")}`);

      for (const page of pagesToCheck) {
        await importTournament(page);
        await sleep(3000);
      }
    } catch (err) {
      console.error(`Failed processing ${t.name}:`, err.message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
