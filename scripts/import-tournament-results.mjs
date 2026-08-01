// Livevival — imports final tournament standings (place, team, prize money,
// and any extra columns like club championship points) from Liquipedia's
// standard prizepool table, which every finished tournament page has.
//
// Structure (confirmed against a real api.php response for MSC/2026):
//   table.prizepooltable.prizepooltable-placement
//     tr.table2__row--head        header row (column labels vary per event —
//                                  we don't rely on reading these, just count
//                                  the data-align="right" columns positionally)
//     tr.table2__row--body        one row per team, EXCEPT tied placements
//       td.prizepooltable-place   rank, e.g. "1" or "5-8" for a tied group.
//                                  Only present on the FIRST row of a tied
//                                  group (uses rowspan) — carry the value
//                                  forward for the rows under it.
//       td.prizepooltable-col-team .name   team name, or "TBD" pre-completion
//       td[data-align="right"]    prize money (first one) + any extra
//                                  tournament-specific columns after it
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function parsePlacementSort(placement) {
  const m = placement.match(/\d+/);
  return m ? Number(m[0]) : null;
}

function parseMoney(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.]/g, "");
  return cleaned ? Number(cleaned) : null;
}

function extractResults($) {
  const results = [];
  let currentPlacement = null;

  $("table.prizepooltable tr.table2__row--body").each((_, tr) => {
    const $tr = $(tr);
    const placeCell = $tr.find("td.prizepooltable-place");
    if (placeCell.length > 0) {
      currentPlacement = placeCell.text().trim();
    }
    if (!currentPlacement) return; // header/malformed row, skip

    const teamName = $tr.find("td.prizepooltable-col-team .name").first().text().trim();
    if (!teamName) return;

    const rightAlignedCells = $tr.find('td[data-align="right"]');
    const prizeUsd = rightAlignedCells.length > 0 ? parseMoney($(rightAlignedCells[0]).text()) : null;
    const extra = {};
    rightAlignedCells.each((i, td) => {
      if (i === 0) return; // already captured as prizeUsd
      const text = $(td).text().trim();
      if (text) extra[`col_${i}`] = text;
    });

    results.push({
      placement: currentPlacement,
      teamNameRaw: teamName,
      prizeUsd,
      extra: Object.keys(extra).length > 0 ? extra : null,
    });
  });

  return results;
}

async function findTeamId(name) {
  if (!name || name === "TBD") return null;
  const { data } = await supabase.from("teams").select("id").ilike("name", name.trim()).maybeSingle();
  return data?.id ?? null;
}

export async function importTournamentResults(pageTitle) {
  const { data: tournament } = await supabase
    .from("tournaments")
    .select("id, name")
    .eq("liquipedia_slug", pageTitle)
    .maybeSingle();

  if (!tournament) {
    console.warn(`Tournament "${pageTitle}" not found in DB — run the tournament importer first.`);
    return;
  }

  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);
  const results = extractResults($);
  console.log(`Found ${results.length} placement row(s) for ${tournament.name}`);

  for (const r of results) {
    const teamId = await findTeamId(r.teamNameRaw);
    const { error } = await supabase.from("tournament_results").upsert(
      {
        tournament_id: tournament.id,
        placement: r.placement,
        placement_sort: parsePlacementSort(r.placement),
        team_id: teamId,
        team_name_raw: r.teamNameRaw,
        prize_usd: r.prizeUsd,
        extra: r.extra,
      },
      { onConflict: "tournament_id,placement,team_name_raw" }
    );
    if (error) console.error(`Failed to upsert placement for ${r.teamNameRaw}:`, error.message);
  }

  console.log(`Imported standings for ${tournament.name}`);
}

async function main() {
  const pageTitle = process.argv[2];
  if (!pageTitle) {
    console.error("Usage: node scripts/import-tournament-results.mjs <Liquipedia_Page_Title>");
    console.error('Example: node scripts/import-tournament-results.mjs "MSC/2026"');
    console.error("Run this on the TOP-LEVEL tournament page (not a stage subpage) — that's");
    console.error("where the final prizepool/placement table lives.");
    process.exit(1);
  }
  await importTournamentResults(pageTitle);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
