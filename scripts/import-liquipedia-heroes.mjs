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
// pages, have produced almost no rows in production).
//
// Names come from action=query&list=categorymembers&cmtitle=Category:Hero —
// the wiki's own categorization, stable across template changes. Icons do
// NOT come from action=query&prop=pageimages: confirmed live that this
// wiki doesn't have the PageImages extension enabled at all ("Unrecognized
// value for parameter \"prop\": pageimages"). Instead, each hero's own
// rendered page is fetched and the portrait is read straight out of its
// infobox (confirmed selector: `.infobox-image img`, e.g. Chou's page has
// "Chou_Infobox.jpg" as literally the first image in that container) — one
// request per hero, same pattern the other importers already use for
// team/match data, just paced slower since it's ~130 individual page fetches
// instead of a handful of batched queries.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php, paced requests.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { apiQuery, fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const CATEGORY = process.env.LIQUIPEDIA_HERO_CATEGORY || "Category:Hero";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchAllHeroTitles() {
  const titles = [];
  let cmcontinue;
  do {
    const data = await apiQuery({
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
    if (cmcontinue) await sleep(4000);
  } while (cmcontinue);
  return titles;
}

async function fetchHeroIcon(title) {
  const html = await fetchRenderedPage(title);
  const $ = cheerio.load(html);
  const src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
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
        `Set LIQUIPEDIA_HERO_CATEGORY to override.`
    );
    console.error("Looking up real category names containing 'hero' to help pick the right one...");
    try {
      const discovery = await apiQuery({ action: "query", list: "allcategories", acprefix: "Hero", aclimit: "50" });
      const candidates = (discovery.query?.allcategories ?? []).map((c) => c["*"] ?? c.category);
      console.error(candidates.length > 0 ? `Candidates: ${candidates.join(", ")}` : "No categories starting with 'Hero' found either.");
    } catch (err) {
      console.error("Category discovery failed:", err.message);
    }
    process.exit(1);
  }

  // Only fetch a per-hero page for heroes that don't already have an icon —
  // this is what makes re-runs cheap (a handful of new/renamed heroes per
  // patch) instead of re-fetching all ~130 pages every 6 hours forever.
  const { data: existingHeroes } = await supabase.from("heroes").select("name, icon_url");
  const missingIcon = new Set(
    (existingHeroes ?? []).filter((h) => !h.icon_url).map((h) => h.name)
  );
  const knownNames = new Set((existingHeroes ?? []).map((h) => h.name));
  const needsIconFetch = titles.filter((t) => !knownNames.has(t) || missingIcon.has(t));

  console.log(`${needsIconFetch.length} of ${titles.length} hero(es) need an icon fetch this run`);

  for (const title of titles) {
    let iconUrl = null;
    if (needsIconFetch.includes(title)) {
      try {
        iconUrl = await fetchHeroIcon(title);
      } catch (err) {
        console.error(`Failed to fetch icon for "${title}":`, err.message);
      }
      await sleep(4000);
    }
    await upsertHero(title, iconUrl);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
