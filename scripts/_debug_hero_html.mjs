import { fetchRenderedPage } from "./_liquipedia.mjs";
import * as cheerio from "cheerio";

const html = await fetchRenderedPage("Chou");
const $ = cheerio.load(html);

console.log("--- all img tags with src (first 15) ---");
$("img").slice(0, 15).each((_, el) => {
  console.log($(el).attr("src"), "| class:", $(el).attr("class"), "| parent class:", $(el).parent().attr("class"));
});

console.log("--- infobox-ish containers found ---");
["infobox", "infobox-image", "infobox-icon", ".hero-infobox", "[class*='infobox']"].forEach((sel) => {
  console.log(sel, "->", $(sel).length);
});
