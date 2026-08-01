import { fetchRenderedPage } from "./_liquipedia.mjs";
import * as cheerio from "cheerio";

const html = await fetchRenderedPage("Chou");
const $ = cheerio.load(html);

console.log("--- classes containing 'infobox' (unique) ---");
const classes = new Set();
$("[class*='infobox']").each((_, el) => {
  ($(el).attr("class") || "").split(/\s+/).forEach((c) => c.includes("infobox") && classes.add(c));
});
console.log([...classes].join(", "));

console.log("--- first infobox-like element's outer HTML (truncated) ---");
const first = $("[class*='infobox']").first();
console.log(first.parent().html()?.slice(0, 1500));

console.log("--- all distinct img src patterns (first 40, deduped by dir) ---");
const seen = new Set();
$("img").each((_, el) => {
  const src = $(el).attr("src") || "";
  if (!seen.has(src)) {
    seen.add(src);
    if (seen.size <= 40) console.log(src);
  }
});
