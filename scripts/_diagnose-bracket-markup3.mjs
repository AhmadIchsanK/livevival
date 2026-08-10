// Throwaway diagnostic #3 — dumps the full recursive structure of bracket
// #4 (the anomalous single-elim Round of 16 -> Grand Final bracket) so the
// real nesting shape can be understood. Deleted after use.
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const pageTitle = process.argv[2] ?? "Games_of_the_Future/2026";
const targetBracketIndex = Number(process.argv[3] ?? 4);

function ownText($, el) {
  return $(el)
    .contents()
    .filter((_, n) => n.type === "text")
    .text()
    .trim();
}

function dump($, el, depth, maxDepth) {
  if (depth > maxDepth) return;
  const $el = $(el);
  const cls = $el.attr("class") ?? "";
  const isRelevant =
    /brkts-/.test(cls) || $el.find(".brkts-header-div").length > 0 || $el.hasClass("brkts-popup-container");
  const text = ownText($, el);
  const headerDivText = $el.hasClass("brkts-header-div") ? text : "";
  const label = [
    "  ".repeat(depth),
    `<${el.tagName}`,
    cls ? ` class="${cls}"` : "",
    ">",
    text ? ` ownText="${text}"` : "",
  ].join("");
  if (isRelevant) console.log(label);
  const children = $el.children().toArray();
  for (const child of children) {
    dump($, child, depth + 1, maxDepth);
  }
}

async function main() {
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);

  const bracket = $(".brkts-bracket").get(targetBracketIndex);
  if (!bracket) {
    console.log(`No bracket at index ${targetBracketIndex}`);
    return;
  }

  console.log(`=== Recursive dump of bracket #${targetBracketIndex} (depth-limited) ===`);
  dump($, bracket, 0, 6);

  console.log("\n=== All distinct classes containing 'brkts-round' or 'brkts-header' within this bracket ===");
  const classSet = new Set();
  $(bracket)
    .find("*")
    .each((_, el) => {
      const cls = $(el).attr("class");
      if (cls && /brkts-round|brkts-header/.test(cls)) classSet.add(cls);
    });
  for (const c of classSet) console.log(c);

  console.log("\n=== Popup match -> nearest ancestor chain of interest ===");
  $(bracket)
    .find(".brkts-popup-container.brkts-match-info-popup")
    .each((i, popup) => {
      const left = $(popup).find(".match-info-header-opponent-left a[title]").first().attr("title");
      const rightOpp = $(popup).find(".match-info-header-opponent").not(".match-info-header-opponent-left").first();
      const right = rightOpp.find("a[title]").first().attr("title");
      const chain = $(popup)
        .parents()
        .toArray()
        .filter((a) => {
          const cls = $(a).attr("class") ?? "";
          return /brkts-round|brkts-bracket|brkts-match\b/.test(cls);
        })
        .map((a) => $(a).attr("class"))
        .reverse();
      console.log(`${left} vs ${right}: [${chain.join(" > ")}]`);
    });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
