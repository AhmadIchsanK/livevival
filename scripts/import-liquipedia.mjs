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

    // href comes straight from Liquipedia's own markup, which percent-
    // encodes punctuation like an apostrophe (e.g. "Women%27s") — decoding
    // it here is what makes liquipedia_slug match what Next.js's dynamic
    // route params give back (the framework decodes the URL path segment
    // before the page ever sees it), instead of storing the raw encoded
    // form and never matching a lookup again (confirmed against a real
    // "No tournament found" case: MLBB_Women%27s_International/2026 in the
    // DB vs the decoded "MLBB_Women's_International/2026" the route saw).
    const slug = decodeURIComponent(href.replace(/^\/mobilelegends\//, ""));
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
  // DISCOVERY-ONLY policy: the S/A-Tier_Tournaments pages this importer reads
  // list only current-and-relevant tournaments (upcoming, ongoing, and a
  // recent completed window) — a tournament appearing there at all is, by
  // definition, one we want in the table. So an UNparseable date is kept, not
  // dropped: this is exactly the "a just-announced season whose date string
  // we couldn't parse silently never appears" bug (see parseDateRange — a
  // same-month range like "Aug 21–30, 2026" used to yield both-null and get
  // dropped here). Keeping it as a shell is harmless — the site's own
  // categorize() falls back to date_display text — whereas dropping it makes
  // a real tournament vanish. NOTE: this "keep on both-null" rule is safe
  // *only* for discovery; the match/result importers deliberately do NOT
  // keep both-null (they walk the full DB incl. years of history and would
  // flood their rate-limited per-tournament fetches).
  if (!startDate && !endDate) return true;
  const cutoff = Date.now() - ONE_YEAR_MS;
  const end = endDate ? new Date(endDate).getTime() : null;
  // No end date (e.g. ongoing/ TBD finish) — keep it, it can't be stale.
  if (end === null) return true;
  return end >= cutoff;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function partMonth(str) {
  const m = str.match(/([A-Za-z]{3,})/);
  const idx = m ? MONTHS[m[1].slice(0, 3).toLowerCase()] : undefined;
  return idx == null ? null : idx;
}
function partDay(str) {
  const m = str.match(/(\d{1,2})(?!\d)/);
  return m ? Number(m[1]) : null;
}
function partYear(str) {
  const m = str.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}
function makeUTCDate(month, day, year) {
  if (month == null || day == null || year == null) return null;
  const d = new Date(Date.UTC(year, month, day));
  return isNaN(d.getTime()) ? null : d;
}

// Parses Liquipedia's free-text date column into real start/end dates so the
// public site can classify upcoming/ongoing/completed precisely instead of
// guessing from match statuses. Token-based (not new Date() on a split half)
// so it survives every real-world shape seen in production, all of which the
// previous split-on-dash version silently returned both-null for — the exact
// failure mode that lets a real (esp. upcoming) tournament get dropped:
//   "Jul 01 – Aug 01, 2026"        cross-month, left borrows right's year
//   "Oct 27, 2018 – Jan 13, 2019"  cross-New-Year, each side its own year
//   "Apr 07–13, 2025"              same-month, right borrows left's month
//   "Nov 27 - Dec 06, 2020"        ASCII-hyphen separator (not en/em dash)
//   "Aug 21, 2026"                 single date (start == end)
// A bare year with no month/day (e.g. "2026", a TBD finish) still yields null
// deliberately — Jan-1 fabrication would misclassify an upcoming event as
// already over.
function parseDateRange(dateDisplay) {
  if (!dateDisplay) return { startDate: null, endDate: null };
  const parts = dateDisplay.split(/\s*[–—-]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { startDate: null, endDate: null };

  // The year is stated once (on the right) unless the range crosses New
  // Year's, in which case each side carries its own — so each part uses its
  // own year when present, else this single trailing year for the string.
  const globalYear = partYear(dateDisplay);

  const left = parts[0];
  const leftMonth = partMonth(left);
  const start = makeUTCDate(leftMonth, partDay(left), partYear(left) ?? globalYear);

  if (parts.length === 1) {
    if (!start) return { startDate: null, endDate: null };
    const iso = start.toISOString().slice(0, 10);
    return { startDate: iso, endDate: iso };
  }

  const right = parts[parts.length - 1];
  // Same-month ranges state the month only on the left ("Apr 07–13") so the
  // right borrows it; cross-month ranges state their own.
  const end = makeUTCDate(partMonth(right) ?? leftMonth, partDay(right), partYear(right) ?? globalYear);

  const startIso = start ? start.toISOString().slice(0, 10) : null;
  const endIso = end ? end.toISOString().slice(0, 10) : null;

  // An end before the start is never correct — fall back to no end date
  // rather than storing a nonsensical range.
  if (start && end && end.getTime() < start.getTime()) {
    return { startDate: startIso, endDate: null };
  }
  return { startDate: startIso, endDate: endIso };
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
