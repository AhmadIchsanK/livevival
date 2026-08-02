// Livevival — Phase 4 stopgap: import S/A-Tier MLBB tournaments from
// Liquipedia's free public MediaWiki API (no API key required).
//
// How it works: the "S-Tier_Tournaments" / "A-Tier_Tournaments" wiki pages
// don't contain plain tournament names in their wikitext — they contain a
// template call that Liquipedia's own server fills in with a real table
// when the page is rendered. So instead of reading raw wikitext, we ask
// the API to hand us the *rendered* HTML (still the official API endpoint,
// still fully compliant with Liquipedia's terms) and parse the resulting
// table with cheerio.
//
// Respects Liquipedia's API Terms of Use:
//   - custom User-Agent identifying the project + contact email
//   - 1 request every 2 seconds between the two page fetches
//   - only ever calls api.php, never scrapes a rendered page directly

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function extractTournaments(html) {
  const $ = cheerio.load(html);
  const tournaments = [];

  $("tr.table2__row--body").each((_, row) => {
    const $row = $(row);
    const link = $row.find("td.column__tournament a").first();
    const name = link.text().trim();
    const href = link.attr("href");
    if (!name || !href) return;

    const slug = href.replace(/^\/mobilelegends\//, "");
    const dateDisplay = $row.find("td.column__tournament").next().text().trim();

    tournaments.push({ name, slug, dateDisplay });
  });

  return tournaments;
}

// Keeps the tournament list (and everything downstream — matches, streams)
// scoped to what's actually relevant for a live-score site, and keeps the
// match importer's runtime short enough to avoid Liquipedia's rate limiter.
//
// Rolling 1-year window, NOT calendar year: a string match on "includes
// current year" used to be used here, which silently drops any tournament
// that started in a prior calendar year but is still well within the past
// 12 months (e.g. a tournament from Nov 2025 while today is Aug 2026) —
// and the drop compounds every Jan 1 when the "current year" shifts and a
// whole year of still-in-window tournaments stops being refreshed. Uses
// the parsed dates so upcoming/ongoing tournaments (end date in the
// future, or unknown) are always kept regardless of window.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
function isWithinPastYear(startDate, endDate) {
  if (!startDate && !endDate) return false; // can't classify — skip, same as before
  const cutoff = Date.now() - ONE_YEAR_MS;
  const end = endDate ? new Date(endDate).getTime() : null;
  // No end date (e.g. ongoing/ TBD finish) — keep it, it can't be stale.
  if (end === null) return true;
  return end >= cutoff;
}

// Liquipedia's date ranges look like "Jul 01 – Aug 01, 2026" (left side
// missing a year, borrows the right side's) or "Oct 27, 2018 – Jan 13, 2019"
// (both sides have their own year, when a tournament spans New Year's).
// Parses into real Date objects so the public site can correctly classify
// upcoming/ongoing/completed instead of guessing from matches alone.
function parseDateRange(dateDisplay) {
  if (!dateDisplay) return { startDate: null, endDate: null };

  const parts = dateDisplay.split(/[–—]/).map((s) => s.trim());
  if (parts.length !== 2) return { startDate: null, endDate: null };

  const [left, right] = parts;
  // A bare 4-digit year (e.g. "2026", meaning Liquipedia hasn't confirmed
  // an end date yet) would otherwise silently parse as Jan 1 of that year
  // via `new Date("2026")` — and Jan 1 can land *before* a valid start
  // date later that same year (a tournament starting in August would
  // "end" the previous January), misclassifying an upcoming tournament as
  // already completed. Treat it the same as no end date at all.
  if (/^\d{4}$/.test(right)) return { startDate: null, endDate: null };

  const endDate = new Date(right);
  if (isNaN(endDate.getTime())) return { startDate: null, endDate: null };

  const leftHasYear = /\d{4}/.test(left);
  const startDate = leftHasYear ? new Date(left) : new Date(`${left}, ${endDate.getFullYear()}`);
  if (isNaN(startDate.getTime())) return { startDate: null, endDate: endDate.toISOString().slice(0, 10) };

  // General sanity check regardless of root cause — an end date before
  // the start date is never correct, and categorizing by a nonsensical
  // range is worse than falling back to the match-status heuristic.
  if (endDate.getTime() < startDate.getTime()) {
    return { startDate: startDate.toISOString().slice(0, 10), endDate: null };
  }

  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

async function importTier(pageTitle, tierLabel) {
  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const parsed = extractTournaments(html).map((t) => ({ ...t, ...parseDateRange(t.dateDisplay) }));
  const tournaments = parsed.filter((t) => isWithinPastYear(t.startDate, t.endDate));
  console.log(
    `Found ${tournaments.length} of ${parsed.length} tournaments on ${pageTitle} within the past year (others skipped as out of scope)`
  );

  for (const t of tournaments) {
    const { startDate, endDate } = t;

    const { error } = await supabase.from("tournaments").upsert(
      {
        name: t.name,
        tier: tierLabel,
        liquipedia_slug: t.slug,
        date_display: t.dateDisplay,
        start_date: startDate,
        end_date: endDate,
      },
      { onConflict: "liquipedia_slug" }
    );

    if (error) {
      console.error(`Failed to upsert "${t.name}": ${error.message}`);
    } else {
      console.log(`Upserted: ${t.name} (${tierLabel}-Tier, ${startDate ?? "?"} to ${endDate ?? "?"})`);
    }
  }
}

async function main() {
  await importTier("S-Tier_Tournaments", "S");
  await sleep(4000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  await importTier("A-Tier_Tournaments", "A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
