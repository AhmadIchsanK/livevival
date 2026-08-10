// Throwaway diagnostic — dumps every infobox label + notable page section
// found on one real team, hero, and player page, to audit what data is
// available on Liquipedia that we don't currently capture into the schema.
// Deleted after use.
import * as cheerio from "cheerio";
import { fetchRenderedPage, getInfoboxRows } from "./_liquipedia.mjs";

async function dumpPage(label, pageTitle) {
  console.log(`\n=== ${label}: ${pageTitle} ===`);
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);

  const rows = getInfoboxRows($);
  console.log(`-- Infobox labels (${rows.size}) --`);
  for (const key of rows.keys()) console.log(`  "${key}"`);

  console.log("-- Section headings (h2/h3) --");
  $("h2, h3").each((_, el) => {
    const text = $(el).text().trim();
    if (text) console.log(`  ${el.tagName}: "${text}"`);
  });

  const infoboxIcons = $(".infobox-icons a[href]").length;
  console.log(`-- .infobox-icons links: ${infoboxIcons} --`);

  const achievementsTable = $("table.achievements-table, .infobox-achievements, .Achievements").length;
  console.log(`-- achievements-ish elements: ${achievementsTable} --`);
}

async function main() {
  await dumpPage("TEAM", "ONIC");
  await dumpPage("HERO", "Ling");
  await dumpPage("PLAYER", "Kairi");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
