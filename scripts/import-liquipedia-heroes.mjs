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
// the wiki's own categorization, stable across template changes.
//
// Icons: Liquipedia has a dedicated small square icon per hero, separate
// from the tall infobox portrait — filename convention
// "File:ML_icon_<HeroName>.png" (confirmed against a real URL the owner
// pasted from production: .../ML_icon_Aamon.png/85px-ML_icon_Aamon.png).
// Resolved via action=query&titles=File:...&prop=imageinfo rather than
// guessing the CDN path (MediaWiki shards file storage into a hash-prefixed
// directory — "1/14" in that example — that can't be computed without
// either the API or replicating MediaWiki's own hashing), which also
// degrades cleanly: if a hero's name doesn't match this convention exactly,
// the API just reports the file missing and this falls back to the old
// infobox-portrait scrape rather than erroring. Icons do NOT come from
// action=query&prop=pageimages: confirmed live that this wiki doesn't have
// the PageImages extension enabled at all ("Unrecognized value for
// parameter \"prop\": pageimages").
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php, paced requests.
//
// Also scrapes lane/role/region metadata (owner request: keep these in
// sync with Liquipedia, same as name/icon). Deliberately reuses each
// hero's own infobox page rather than the hand-styled Portal:Heroes grid
// — same reasoning as the icon scrape above (drift-prone template CSS),
// and confirmed via a real job log (see PR) that Portal:Heroes' "Lane" /
// "Role" / "Region" tabs are just alternate groupings of that same grid,
// not a more reliable source. The per-hero infobox structure was
// confirmed live against Chou's page: `.infobox-description` cells
// labeled "Region:", "Role:", "Lane:" sit right next to their value cell
// — identical shape to the one backfill-player-photos.mjs already
// extracts "Name:"/"Nationality:" from, so getInfoboxRows() here is a
// deliberate copy of that helper (small enough, and each backfill/import
// script in this repo already keeps its own copy rather than sharing one
// — see backfill-hero-icons.mjs's note on the same tradeoff).
//
// role/lane/region are only ever filled in when null — like icon_url,
// once a value is scraped (or an admin sets one by hand) this script
// never overwrites it, so re-runs stay cheap: after the first full pass
// over the existing roster, only genuinely new heroes need the extra
// infobox fetch this does for metadata.

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

async function fetchHeroSmallIcon(heroName) {
  const filename = `ML_icon_${heroName.replace(/ /g, "_")}.png`;
  const data = await apiQuery({
    action: "query",
    titles: `File:${filename}`,
    prop: "imageinfo",
    iiprop: "url",
  });
  const pages = data.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  return page.imageinfo?.[0]?.url ?? null;
}

async function fetchHeroInfoboxPortrait(title) {
  const html = await fetchRenderedPage(title);
  const $ = cheerio.load(html);
  // Same infobox structure confirmed on team pages: light/dark image
  // variants both under .infobox-image, light listed first. Try that
  // specific variant before falling back to the bare selector in case a
  // hero page's infobox doesn't split by mode at all.
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

async function fetchHeroIcon(title) {
  const smallIcon = await fetchHeroSmallIcon(title);
  if (smallIcon) return smallIcon;
  // Falls back to the full portrait for any hero whose name doesn't match
  // the ML_icon_<Name>.png convention exactly — better than no image at all.
  // Extra pacing here since this is a second sequential request for the
  // same hero, on top of the caller's own per-hero sleep.
  await sleep(4000);
  return fetchHeroInfoboxPortrait(title);
}

// Same infobox-row lookup backfill-player-photos.mjs uses for player
// pages (`.infobox-description` label cell + its adjacent value cell) —
// deliberately duplicated rather than imported, matching this repo's
// existing per-script-copy convention for this exact helper.
function getInfoboxRows($) {
  const rows = new Map();
  $(".infobox-description").each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, "").toLowerCase();
    rows.set(label, $(el).next());
  });
  return rows;
}

// Confirmed live against Chou's rendered infobox: Role/Lane values sit
// next to a small icon `<img>` with empty alt text, so cheerio's .text()
// on the value cell already returns just the label text. A hero flexed
// across two lanes/roles renders each on its own line via <br> — swapped
// for " / " first so those don't get silently concatenated with no
// separator.
function cleanInfoboxValue(cell) {
  if (!cell) return null;
  cell.find("br").replaceWith(" / ");
  const text = cell.text().replace(/\s+/g, " ").trim();
  return text || null;
}

function extractHeroMetadata($) {
  const rows = getInfoboxRows($);
  return {
    role: cleanInfoboxValue(rows.get("role")),
    lane: cleanInfoboxValue(rows.get("lane")),
    region: cleanInfoboxValue(rows.get("region")),
  };
}

async function fetchHeroMetadata(title) {
  const html = await fetchRenderedPage(title);
  const $ = cheerio.load(html);
  return extractHeroMetadata($);
}

async function upsertHero(name, iconUrl, metadata) {
  const { data: existing } = await supabase
    .from("heroes")
    .select("id, icon_url, role, lane, region")
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    const update = {};
    // Fill in a missing icon, or upgrade an old infobox-portrait URL (this
    // script's own earlier output, before the small-icon source existed) to
    // the new small icon — but never touch a value that's neither: that's
    // either already a good small icon or something an admin set by hand.
    const isUpgradeable = !existing.icon_url || /infobox/i.test(existing.icon_url);
    if (iconUrl && isUpgradeable && iconUrl !== existing.icon_url) update.icon_url = iconUrl;
    // Same "only fill a gap, never overwrite" rule for role/lane/region —
    // whether the existing value came from an earlier scrape or an admin
    // edit, this script has no way to tell the difference and shouldn't
    // clobber either.
    if (metadata) {
      if (!existing.role && metadata.role) update.role = metadata.role;
      if (!existing.lane && metadata.lane) update.lane = metadata.lane;
      if (!existing.region && metadata.region) update.region = metadata.region;
    }
    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from("heroes").update(update).eq("id", existing.id);
      if (error) console.error(`Failed to update "${name}":`, error.message);
    }
    return;
  }

  const { error } = await supabase.from("heroes").insert({
    name,
    liquipedia_slug: name.replace(/ /g, "_"),
    icon_url: iconUrl,
    role: metadata?.role ?? null,
    lane: metadata?.lane ?? null,
    region: metadata?.region ?? null,
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

  // Only fetch a per-hero page for heroes that don't already have a *good*
  // icon — this is what makes re-runs cheap (a handful of new/renamed
  // heroes per patch) instead of re-fetching all ~130 pages every 6 hours
  // forever. "Good" excludes the old infobox-portrait URLs this script used
  // to produce before the small-icon source existed, so those get upgraded
  // once and then left alone.
  const { data: existingHeroes } = await supabase.from("heroes").select("name, icon_url, role, lane, region");
  const needsUpgrade = new Set(
    (existingHeroes ?? []).filter((h) => !h.icon_url || /infobox/i.test(h.icon_url)).map((h) => h.name)
  );
  const needsMetadata = new Set(
    (existingHeroes ?? []).filter((h) => !h.role || !h.lane || !h.region).map((h) => h.name)
  );
  const knownNames = new Set((existingHeroes ?? []).map((h) => h.name));
  const needsIconFetch = titles.filter((t) => !knownNames.has(t) || needsUpgrade.has(t));
  const needsMetadataFetch = titles.filter((t) => !knownNames.has(t) || needsMetadata.has(t));

  console.log(`${needsIconFetch.length} of ${titles.length} hero(es) need an icon fetch this run`);
  console.log(`${needsMetadataFetch.length} of ${titles.length} hero(es) need a role/lane/region fetch this run`);

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

    let metadata = null;
    if (needsMetadataFetch.includes(title)) {
      try {
        metadata = await fetchHeroMetadata(title);
      } catch (err) {
        console.error(`Failed to fetch role/lane/region for "${title}":`, err.message);
      }
      await sleep(4000);
    }

    await upsertHero(title, iconUrl, metadata);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
