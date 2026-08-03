// Livevival — one-time backfill: fetches a Liquipedia icon for every hero
// row that's still missing one.
//
// Root cause of 80/133 heroes having no icon_url (confirmed via the real
// GitHub Actions job logs for import-liquipedia-heroes.mjs): that script's
// very first request — action=query&list=categorymembers, to list the
// full hero roster — was hitting a sustained 429 from Liquipedia, most
// likely from contention with the other two Liquipedia-scraper jobs
// (import-tournaments, import-matches) running concurrently in the same
// workflow. All 6 retries (20s..120s backoff, ~7 minutes) were exhausted
// and the script crashed before fetching a single icon, every single run
// — so the missing set never shrank even across many scheduled runs.
//
// This script sidesteps that exact failure point: it never calls
// categorymembers at all. The 80 hero names/slugs needing an icon are
// already sitting in the `heroes` table (added by a run that got far
// enough to insert the row before failing on a later request, or by an
// earlier version of the importer), so this only needs a DB read plus the
// same per-hero icon fetch import-liquipedia-heroes.mjs already uses.
//
// Not a recurring workflow: dispatched manually once. Once these are
// backfilled, import-liquipedia-heroes.mjs's own per-run skip logic
// (needsIconFetch) keeps them from ever being null again.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { apiQuery, fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Identical to import-liquipedia-heroes.mjs's fetchHeroSmallIcon /
// fetchHeroInfoboxPortrait / fetchHeroIcon — kept as a literal copy rather
// than a shared import so this one-time script has zero coupling to that
// recurring script's own control flow (main()'s categorymembers call).
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
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

async function fetchHeroIcon(title) {
  const smallIcon = await fetchHeroSmallIcon(title);
  if (smallIcon) return smallIcon;
  await sleep(4000);
  return fetchHeroInfoboxPortrait(title);
}

async function main() {
  const { data: heroes, error } = await supabase
    .from("heroes")
    .select("id, name, liquipedia_slug")
    .is("icon_url", null);
  if (error) throw error;

  console.log(`${heroes.length} hero(es) missing an icon`);

  for (const h of heroes) {
    const title = (h.liquipedia_slug || h.name).replace(/_/g, " ");
    try {
      const iconUrl = await fetchHeroIcon(title);
      if (iconUrl) {
        const { error: updateError } = await supabase.from("heroes").update({ icon_url: iconUrl }).eq("id", h.id);
        if (updateError) console.error(`Failed to save icon for ${h.name}:`, updateError.message);
        else console.log(`${h.name}: icon found`);
      } else {
        console.log(`${h.name}: no icon found (small icon + infobox portrait both missing)`);
      }
    } catch (err) {
      console.error(`Failed processing ${h.name}:`, err.message);
    }
    await sleep(4000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
