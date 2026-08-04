// TEMPORARY debug script — run once via GitHub Actions to inspect real
// Liquipedia popup HTML for live-stream link markup. Not part of the
// permanent scripts/ set; deleted before merge.
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const SLUG = "Games_of_the_Future/2026";

const html = await fetchRenderedPage(SLUG);
const $ = cheerio.load(html);

const popups = $(".brkts-popup-container.brkts-match-info-popup");
console.log(`Found ${popups.length} match popups on ${SLUG}`);

popups.each((i, el) => {
  const $el = $(el);
  const timerEl = $el.find(".timer-object[data-timestamp]").first();
  const timestamp = timerEl.attr("data-timestamp");
  const finished = timerEl.attr("data-finished");
  const teamA = $el.find(".match-info-header-opponent-left a[title]").first().attr("title");
  const teamB = $el
    .find(".match-info-header-opponent")
    .not(".match-info-header-opponent-left")
    .find("a[title]")
    .first()
    .attr("title");

  console.log(`\n=== Popup ${i}: ${teamA} vs ${teamB} | ts=${timestamp} finished=${finished} ===`);

  // Dump the footer area (where vodlink/streams typically live)
  const footer = $el.find(".brkts-popup-footer");
  console.log(`--- .brkts-popup-footer HTML (${footer.length} found) ---`);
  console.log(footer.html());

  // Dump anything with "stream" in class/attr
  const streamish = $el.find('[class*="stream" i], [href*="twitch" i], [href*="youtube" i], a[href*="youtu.be" i]');
  console.log(`--- Elements matching stream/twitch/youtube (${streamish.length}) ---`);
  streamish.each((_, s) => {
    console.log($.html(s));
  });

  // Full popup HTML for the first couple of live/unfinished matches — most useful
  if (finished === undefined && i < 3) {
    console.log(`--- FULL popup HTML (unfinished, index ${i}) ---`);
    console.log($el.html());
  }
});
