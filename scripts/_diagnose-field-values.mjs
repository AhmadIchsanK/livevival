// Throwaway diagnostic — dumps raw cell text for the newly-identified but
// not-yet-captured infobox fields, to pick correct column types before
// writing the migration. Deleted after use.
import * as cheerio from "cheerio";
import { fetchRenderedPage, getInfoboxRows } from "./_liquipedia.mjs";

async function dumpFields(label, pageTitle, fields) {
  console.log(`\n=== ${label}: ${pageTitle} ===`);
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);
  const rows = getInfoboxRows($);
  for (const f of fields) {
    const cell = rows.get(f);
    if (!cell) {
      console.log(`  "${f}": <not found>`);
      continue;
    }
    console.log(`  "${f}": ${JSON.stringify(cell.text().trim())}`);
    console.log(`    html: ${cell.html()?.slice(0, 300)}`);
  }
}

async function main() {
  await dumpFields("TEAM", "ONIC", ["created", "approx. total winnings"]);
  await dumpFields("HERO", "Ling", [
    "price",
    "specialty",
    "resource bar",
    "voice actor(s)",
    "hp",
    "hp regen",
    "energy",
    "energy regen",
    "physical attack",
    "physical defense",
    "magic power",
    "magic defense",
    "attack speed",
    "attack speed ratio",
    "movement speed",
    "win rate",
    "release date",
  ]);
  await dumpFields("PLAYER", "Kairi", [
    "born",
    "status",
    "role",
    "team",
    "alternate ids",
    "nickname(s)",
    "approx. total winnings",
    "signature heroes",
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
