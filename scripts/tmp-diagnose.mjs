// TEMPORARY diagnostic script — not part of the permanent codebase.
// Inspects real Liquipedia page structure for the MPL Season 18 pages to
// figure out why import-liquipedia-matches.mjs finds 0 matches for them.
import * as cheerio from "cheerio";
import { fetchRenderedPage, apiQuery } from "./_liquipedia.mjs";

function countMatchPopups(html) {
  const $ = cheerio.load(html);
  return $(".brkts-popup-container.brkts-match-info-popup").length;
}

function findSubpageLinks(html) {
  const $ = cheerio.load(html);
  const hrefs = new Set();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (href.includes("/mobilelegends/MPL/")) hrefs.add(href);
  });
  return Array.from(hrefs);
}

async function inspect(slug) {
  console.log(`\n=== ${slug} ===`);
  const html = await fetchRenderedPage(slug);
  console.log(`HTML length: ${html.length}`);
  console.log(`Match popups found: ${countMatchPopups(html)}`);
  const links = findSubpageLinks(html).filter((h) => h.includes(slug.split("/").slice(0, 3).join("/")));
  console.log(`Related sub-links (${links.length}):`);
  for (const l of links.slice(0, 40)) console.log(`  ${l}`);
}

async function listSubpages(prefix) {
  console.log(`\n=== allpages prefix=${prefix} ===`);
  const data = await apiQuery({ action: "query", list: "allpages", apprefix: prefix, aplimit: "50" });
  const pages = data?.query?.allpages ?? [];
  for (const p of pages) console.log(`  ${p.title}`);
}

async function main() {
  await inspect("MPL/Indonesia/Season_18");
  await inspect("MPL/Indonesia/Season_18/Regular_Season");
  await listSubpages("MPL/Indonesia/Season_18");

  await inspect("MPL/Philippines/Season_18");
  await inspect("MPL/Philippines/Season_18/Regular_Season");

  await inspect("MPL/Malaysia/Season_18");
  await inspect("MPL/Malaysia/Season_18/Regular_Season");

  // Also check what discovery pages actually list for these, to see if
  // the /Regular_Season slug is what discovery would (or should) capture.
  console.log("\n=== S-Tier_Tournaments rows mentioning MPL ===");
  const sHtml = await fetchRenderedPage("S-Tier_Tournaments");
  const $ = cheerio.load(sHtml);
  $("tr.table2__row--body").each((_, row) => {
    const $row = $(row);
    const link = $row.find("td.column__tournament a").first();
    const name = link.text().trim();
    const href = link.attr("href");
    if (name && /MPL/i.test(name)) console.log(`  ${name} -> ${href}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
