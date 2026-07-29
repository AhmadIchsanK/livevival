// Livevival — Phase 4 stopgap: import tournament shells from Liquipedia's
// public MediaWiki API (no API key required). Pulls name, tier, and dates
// only — full match schedules are NOT scraped here, see README note below.
//
// Respects Liquipedia's API Terms of Use:
//   - custom User-Agent identifying the project + contact email
//   - 1 request every 2 seconds
//   - reads wikitext via the official API, never scrapes rendered HTML pages

import { createClient } from "@supabase/supabase-js";

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";

// TODO: put a real contact email here before running this for real —
// Liquipedia blocks generic/anonymous user agents.
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: YOUR_EMAIL_HERE)";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wikiRequest(params) {
  const url = new URL(WIKI_API);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });
  if (!res.ok) {
    throw new Error(`Liquipedia API returned ${res.status} for ${url}`);
  }
  return res.json();
}

async function getCategoryMembers(categoryTitle) {
  const data = await wikiRequest({
    action: "query",
    list: "categorymembers",
    cmtitle: `Category:${categoryTitle}`,
    cmlimit: "100",
  });
  return (data.query?.categorymembers ?? []).map((m) => m.title);
}

// Crude but dependency-free extraction of a few Infobox league fields
// directly from wikitext. Liquipedia infobox parameter names are fairly
// consistent across wikis, but if this comes back empty for a page,
// open that page's "Edit source" view on Liquipedia to check the actual
// parameter names and adjust the regexes below.
function extractInfoboxField(wikitext, fieldName) {
  const match = wikitext.match(new RegExp(`\\|\\s*${fieldName}\\s*=\\s*([^\\n|]+)`, "i"));
  return match ? match[1].trim() : null;
}

async function importTier(categoryTitle, tierLabel) {
  console.log(`Fetching ${categoryTitle}...`);
  const titles = await getCategoryMembers(categoryTitle);
  console.log(`Found ${titles.length} pages in ${categoryTitle}`);

  for (const title of titles) {
    await sleep(2000); // stay within the 1 request / 2 seconds limit

    const data = await wikiRequest({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      titles: title,
    });

    const pages = data.query?.pages ?? {};
    const page = Object.values(pages)[0];
    const wikitext = page?.revisions?.[0]?.["*"] ?? "";

    const startDate = extractInfoboxField(wikitext, "sdate") ?? extractInfoboxField(wikitext, "date");
    const endDate = extractInfoboxField(wikitext, "edate");

    const { error } = await supabase.from("tournaments").upsert(
      {
        name: title,
        tier: tierLabel,
        liquipedia_slug: title.replace(/ /g, "_"),
        start_date: startDate,
        end_date: endDate,
      },
      { onConflict: "liquipedia_slug" }
    );

    if (error) {
      console.error(`Failed to upsert "${title}": ${error.message}`);
    } else {
      console.log(`Upserted: ${title} (${tierLabel}-Tier, start ${startDate ?? "unknown"})`);
    }
  }
}

async function main() {
  await importTier("S-Tier_Tournaments", "S");
  await importTier("A-Tier_Tournaments", "A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
