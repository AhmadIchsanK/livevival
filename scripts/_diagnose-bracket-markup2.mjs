// Throwaway diagnostic #2 — investigating why deriveStageFromBracket
// assigned "Round of 16" to every playoff match including the confirmed
// Grand Final. Deleted after use.
import * as cheerio from "cheerio";
import { fetchRenderedPage, deriveStageFromBracket } from "./_liquipedia.mjs";

const pageTitle = process.argv[2] ?? "Games_of_the_Future/2026";

async function main() {
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);

  console.log("=== Per-match derived stage (team names + timestamp) ===");
  $(".brkts-popup-container.brkts-match-info-popup").each((_, el) => {
    const $el = $(el);
    const ts = $el.find(".timer-object[data-timestamp]").first().attr("data-timestamp");
    const left = $el.find(".match-info-header-opponent-left a[title]").first().attr("title");
    const rightOpp = $el.find(".match-info-header-opponent").not(".match-info-header-opponent-left").first();
    const right = rightOpp.find("a[title]").first().attr("title");
    const stage = deriveStageFromBracket($, el);
    console.log(`ts=${ts} ${left} vs ${right} -> STAGE="${stage}"`);
  });

  console.log("\n=== All .brkts-bracket containers: direct-child sequence (class + own text) ===");
  $(".brkts-bracket").each((bi, bracket) => {
    console.log(`--- bracket #${bi} ---`);
    $(bracket).children().each((ci, child) => {
      const $c = $(child);
      const cls = $c.attr("class") ?? "";
      const ownText = $c
        .contents()
        .filter((_, n) => n.type === "text")
        .text()
        .trim();
      const headerDivText = $c.find(".brkts-header-div").first().contents().filter((_, n) => n.type === "text").text().trim();
      console.log(`  [${ci}] class="${cls}" ownText="${ownText}" headerDivOwnText="${headerDivText}"`);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
