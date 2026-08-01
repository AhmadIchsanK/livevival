// Livevival — imports the canonical hero roster (name + icon) from
// Liquipedia so the admin panel and public site can show a real portrait
// next to every pick/ban instead of just text, and so pick/ban/roster data
// can be matched to a stable hero_id.
//
// Deliberately does NOT scrape the hand-styled "Portal:Heroes" grid page —
// that kind of page relies on template CSS classes that drift between
// tournaments' own overlay work and site redesigns (this is likely why
// scripts/import-liquipedia-team-rosters.mjs and
// import-liquipedia-region-rosters.mjs, which DO scrape hand-styled portal
// pages, have produced almost no rows in production). Instead this uses two
// core, template-independent MediaWiki API calls that are stable across
// every wiki:
//   - action=query&list=categorymembers&cmtitle=Category:Heroes — the
//     canonical list of hero page titles, maintained by the wiki's own
//     categorization rather than a bespoke portal layout.
//   - action=query&prop=pageimages — each hero page's main image
//     (typically its infobox portrait), batched up to 50 titles per call.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php, paced requests.

import { createClient } from "@supabase/supabase-js";

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";
const CATEGORY = process.env.LIQUIPEDIA_HERO_CATEGORY || "Category:Heroes";
const BATCH_SIZE = 50; // MediaWiki's per-request title limit for non-bot accounts

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(params) {
  const url = new URL(WIKI_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${JSON.stringify(params)}`);
  return res.json();
}

async function fetchAllHeroTitles() {
  const titles = [];
  let cmcontinue;
  do {
    const data = await apiGet({
      action: "query",
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmlimit: "500",
      cmtype: "page",
      ...(cmcontinue ? { cmcontinue } : {}),
    });
    const members = data.query?.categorymembers ?? [];
    for (const m of members) titles.push(m.title);
    cmcontinue = data.continue?.cmcontinue;
    if (cmcontinue) await sleep(2000);
  } while (cmcontinue);
  return titles;
}

// Batched pageimages lookup — returns { [title]: imageUrl|null }
async function fetchThumbnails(titles) {
  const result = {};
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const data = await apiGet({
      action: "query",
      titles: batch.join("|"),
      prop: "pageimages",
      piprop: "thumbnail|name",
      pithumbsize: "300",
    });
    const pages = data.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      if (page.title) result[page.title] = page.thumbnail?.source ?? null;
    }
    if (i + BATCH_SIZE < titles.length) await sleep(2000);
  }
  return result;
}

async function upsertHero(name, iconUrl) {
  const { data: existing } = await supabase
    .from("heroes")
    .select("id, icon_url")
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    // Never clobber an icon an admin manually set/overrode with null, but
    // do fill it in if we now have one and the row didn't.
    if (iconUrl && !existing.icon_url) {
      const { error } = await supabase.from("heroes").update({ icon_url: iconUrl }).eq("id", existing.id);
      if (error) console.error(`Failed to backfill icon for "${name}":`, error.message);
    }
    return;
  }

  const { error } = await supabase.from("heroes").insert({
    name,
    liquipedia_slug: name.replace(/ /g, "_"),
    icon_url: iconUrl,
  });
  if (error && !error.message.includes("duplicate key")) {
    console.error(`Failed to insert hero "${name}":`, error.message);
  } else if (!error) {
    console.log(`Added hero: ${name}${iconUrl ? "" : " (no icon found)"}`);
  }
}

async function main() {
  console.log(`Fetching hero list from ${CATEGORY}...`);
  const titles = await fetchAllHeroTitles();
  console.log(`Found ${titles.length} hero page(s)`);

  if (titles.length === 0) {
    console.error(
      `No pages found in "${CATEGORY}" — the category name may differ on this wiki. ` +
        `Set LIQUIPEDIA_HERO_CATEGORY to override, e.g. "Category:MLBB Heroes".`
    );
    process.exit(1);
  }

  await sleep(2000);
  const thumbnails = await fetchThumbnails(titles);

  for (const title of titles) {
    await upsertHero(title, thumbnails[title] ?? null);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
