// TEMPORARY diagnostic — not part of the app. Confirms Liquipedia actually
// has finished-match detail data (picks/bans/VODs) for a sample of
// tournaments the DB shows as "finished match, but zero games rows", before
// spending real backfill-run time on them. Removed before the final commit.
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const targets = [
  "MPL/Indonesia/Season_17",
  "M7_World_Championship",
  "MLBB_Super_League/Myanmar/Season_3",
  "MLBB_Continental_Championships/Season_6",
];

for (const slug of targets) {
  try {
    const html = await fetchRenderedPage(slug);
    const $ = cheerio.load(html);
    const popups = $(".brkts-popup-container.brkts-match-info-popup").length;
    const finishedTimers = $(".timer-object[data-finished]").filter((_, el) => $(el).attr("data-finished") === "finished").length;
    const champIcons = $(".brkts-champion-icon").length;
    const vodLinks = $(".vodlink a[href]").length;
    console.log(`[${slug}] popups=${popups} finished=${finishedTimers} champIcons=${champIcons} vodLinks=${vodLinks}`);
  } catch (err) {
    console.log(`[${slug}] ERROR: ${err.message}`);
  }
}
