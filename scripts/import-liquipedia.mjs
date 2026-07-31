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

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";

// TODO: put a real contact email here before running this for real —
// Liquipedia blocks generic/anonymous user agents.
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
  if (!res.ok) {
    throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);
  }
  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}

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
const CURRENT_YEAR = new Date().getFullYear().toString();
function isCurrentYear(dateDisplay) {
  return typeof dateDisplay === "string" && dateDisplay.includes(CURRENT_YEAR);
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
  const endDate = new Date(right);
  if (isNaN(endDate.getTime())) return { startDate: null, endDate: null };

  const leftHasYear = /\d{4}/.test(left);
  const startDate = leftHasYear ? new Date(left) : new Date(`${left}, ${endDate.getFullYear()}`);
  if (isNaN(startDate.getTime())) return { startDate: null, endDate: endDate.toISOString().slice(0, 10) };

  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

async function importTier(pageTitle, tierLabel) {
  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const tournaments = extractTournaments(html).filter((t) => isCurrentYear(t.dateDisplay));
  console.log(`Found ${tournaments.length} ${CURRENT_YEAR} tournaments on ${pageTitle} (others skipped as out of scope)`);

  for (const t of tournaments) {
    const { startDate, endDate } = parseDateRange(t.dateDisplay);

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
  await sleep(2000); // stay within the 1 request / 2 seconds limit
  await importTier("A-Tier_Tournaments", "A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
