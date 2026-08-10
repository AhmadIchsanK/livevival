// Throwaway diagnostic — NOT part of the app. Dumps structural info about
// how Liquipedia marks up bracket round/stage names on a single-page
// tournament (no stage subpages), so real selectors can be confirmed
// before writing production extraction code. Deleted after use.
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const pageTitle = process.argv[2] ?? "Games_of_the_Future/2026";

async function main() {
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);

  console.log(`=== Elements containing round/stage keywords on ${pageTitle} ===`);
  const keywords = /group stage|grand final|semifinal|quarterfinal|round of|upper bracket|lower bracket|playoff|knockout|swiss/i;
  $("*").each((_, el) => {
    const $el = $(el);
    const ownText = $el.contents().filter((_, n) => n.type === "text").text().trim();
    if (ownText && keywords.test(ownText) && ownText.length < 60) {
      const cls = $el.attr("class") ?? "";
      console.log(`TAG=${el.tagName} CLASS="${cls}" TEXT="${ownText}"`);
    }
  });

  console.log(`\n=== First 3 .brkts-popup-container.brkts-match-info-popup ancestor chains ===`);
  $(".brkts-popup-container.brkts-match-info-popup").slice(0, 3).each((i, el) => {
    const chain = [];
    let node = $(el);
    for (let depth = 0; depth < 6 && node.length; depth++) {
      const cls = node.attr("class") ?? "(no class)";
      chain.push(`${node.prop("tagName")}.${cls}`);
      node = node.parent();
    }
    console.log(`Popup #${i}: ${chain.join(" < ")}`);
  });

  console.log(`\n=== Distinct classes containing "round" or "bracket" or "header" (bracket-related) ===`);
  const seen = new Set();
  $("[class]").each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    for (const c of cls.split(/\s+/)) {
      if (/round|bracket|header|stage/i.test(c) && !seen.has(c)) {
        seen.add(c);
        console.log(c);
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
