// Livevival — one-time backfill: fetches a Liquipedia tournament logo for
// every tournament row that's still missing one.
//
// Root cause of 150/151 tournaments having no logo: the only existing logo
// scrape lives inside import-tournament-results.mjs, which only ever runs
// for tournaments within refresh-finished-match-details.mjs's rolling
// past-year window (deliberately, to keep that recurring job's runtime
// bounded — see isWithinPastYear there). Most of the 151 tournaments in
// this DB are older S/A-Tier history well outside that window, so they
// never got a turn. A logo is static and doesn't need re-fetching once
// set, so this is a one-time pass rather than a change to the recurring
// job's filtering.
//
// Not a recurring workflow: dispatched manually once. Any newly-imported
// tournament is fresh enough to fall inside the past-year window, so the
// existing recurring path already covers it going forward.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Same extraction pattern as extractLogoUrl in import-team-details.mjs /
// import-tournament-results.mjs — a tournament's own infobox uses the
// identical markup.
function extractLogoUrl($) {
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

async function main() {
  const { data: tournaments, error } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug")
    .is("logo_url", null)
    .not("liquipedia_slug", "is", null);
  if (error) throw error;

  console.log(`${tournaments.length} tournament(s) missing a logo`);

  for (const t of tournaments) {
    try {
      const html = await fetchRenderedPage(t.liquipedia_slug);
      const $ = cheerio.load(html);
      const logoUrl = extractLogoUrl($);
      if (logoUrl) {
        const { error: updateError } = await supabase.from("tournaments").update({ logo_url: logoUrl }).eq("id", t.id);
        if (updateError) console.error(`Failed to save logo for ${t.name}:`, updateError.message);
        else console.log(`${t.name}: logo found`);
      } else {
        console.log(`${t.name}: no infobox image on the page`);
      }
    } catch (err) {
      console.error(`Failed processing ${t.name}:`, err.message);
    }
    await sleep(4000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
