// TEMPORARY diagnostic script — not part of the permanent codebase.
// Dumps raw roster-row HTML for teams known to have produced a
// country-name "player" row, to find the real cause of the misparse.
import * as cheerio from "cheerio";
import { apiQuery } from "./_liquipedia.mjs";

async function fetchTeamPage(slug) {
  const data = await apiQuery({ action: "parse", page: slug, prop: "text", redirects: "1" });
  if (data.error) {
    console.log(`ERROR for ${slug}:`, JSON.stringify(data.error));
    return null;
  }
  return data.parse?.text?.["*"];
}

function dumpRoster(html, slug) {
  const $ = cheerio.load(html);
  const heading = $("h3#Active, h2#Active").first();
  if (heading.length === 0) {
    console.log(`${slug}: no #Active heading found`);
    return;
  }
  const table = heading
    .closest(".mw-heading2, .mw-heading3, .mw-heading")
    .next(".table2--generic")
    .find("table.table2__table")
    .first();
  if (table.length === 0) {
    console.log(`${slug}: no roster table found after #Active heading`);
    return;
  }
  const headers = table.find("tr.table2__row--head th").map((_, th) => $(th).text().trim()).get();
  console.log(`${slug}: headers = ${JSON.stringify(headers)}`);

  table.find("tr.table2__row--body").each((i, row) => {
    const $row = $(row);
    const cells = $row.find("td");
    const cell0Html = $(cells[0]).html();
    const cell0Text = $(cells[0]).text().trim();
    const hasInlinePlayer = $(cells[0]).find(".inline-player").length;
    console.log(`  row ${i}: cellCount=${cells.length} hasInlinePlayer=${hasInlinePlayer} cell0Text="${cell0Text}"`);
    if (cell0Text.length < 20 && /indonesia|philippines|malaysia/i.test(cell0Text)) {
      console.log(`  >>> SUSPECT ROW ${i} cell0 HTML: ${cell0Html}`);
      console.log(`  >>> SUSPECT ROW ${i} full row HTML: ${$.html($row)}`);
    }
  });
}

async function main() {
  for (const slug of ["RRQ Hoshi", "Alter Ego", "ONIC Philippines", "Selangor Red Giants"]) {
    console.log(`\n=== ${slug} ===`);
    const html = await fetchTeamPage(slug);
    if (html) dumpRoster(html, slug);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
