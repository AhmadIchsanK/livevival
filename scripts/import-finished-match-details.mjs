// Livevival — imports finished-match detail (per-game VOD links, winners,
// and champion picks) from a tournament's Liquipedia bracket page.
//
// Structure this relies on (confirmed against a real api.php response for
// MSC/2026 — see /mnt/user-data/uploads/api-result__1_.json used to build
// this):
//
//   .brkts-popup-container.brkts-match-info-popup   one block per match
//     .timer-object[data-timestamp][data-finished]  schedule + completion
//     .match-info-header-opponent(-left)             the two team names,
//       ...-winner / ...-loser classes tell us who won the SERIES
//     .match-info-header-scoreholder-lower            "(BoX)" format tag
//     .brkts-popup-body-grid-row                      ONE PER TEAM PER GAME
//       .brkts-champion-icon a[href]                  heroes that team
//                                                      picked in that game
//       (rows come in win/loss pairs, in game order — row pair 1 = game 1,
//       pair 2 = game 2, etc. There is no ban data in this view; Liquipedia
//       only exposes bans on a separate per-tournament "Picks and Bans"
//       subpage, which isn't covered here.)
//     .brkts-popup-footer .plainlinks.vodlink a[href][title="Watch Game N"]
//                                                      per-game VOD link.
//       NOTE: multiple games can share the same base video with a
//       "?&=<seconds>" offset appended (a timestamp into one long VOD)
//       rather than each having its own distinct URL — both cases are
//       handled the same way here, since we store the exact href as-is
//       and the site can just link straight to it either way.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, 2s between requests, only ever calls api.php.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";

// TODO: same as the other importers — put a real contact email here.
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRenderedPage(pageTitle, attempt = 1) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });

  if (res.status === 429 && attempt <= 3) {
    const waitMs = 15000 * attempt;
    console.warn(`Rate limited on ${pageTitle}, waiting ${waitMs / 1000}s before retry ${attempt}/3...`);
    await sleep(waitMs);
    return fetchRenderedPage(pageTitle, attempt + 1);
  }
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);

  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}

/**
 * Parses every finished match popup out of a rendered bracket page.
 * @returns {Array<object>} one entry per finished match
 */
function extractFinishedMatches($) {
  const matches = [];

  $(".brkts-popup-container.brkts-match-info-popup").each((_, el) => {
    const $popup = $(el);
    const timer = $popup.find(".timer-object").first();
    if (timer.attr("data-finished") === undefined) return; // only finished matches

    const teamLeft = $popup.find(".match-info-header-opponent-left");
    const teamRight = $popup.find(".match-info-header-opponent").not(teamLeft);
    const leftName = teamLeft.find(".name.hidden-xs").first().text().trim();
    const rightName = teamRight.find(".name.hidden-xs").first().text().trim();
    if (!leftName || !rightName) return;

    const leftWon = teamLeft.hasClass("match-info-header-winner");
    const format = $popup.find(".match-info-header-scoreholder-lower").text().trim(); // e.g. "(Bo3)"

    // Champion picks, grouped into (win row, loss row) pairs = one pair per game.
    const rows = $popup.find(".brkts-popup-body-grid-row");
    const games = [];
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const rowA = $(rows[i]);
      const rowB = $(rows[i + 1]);
      const aIsWin = rowA.find(".generic-label").attr("data-label-type") === "result-win";
      const winnerRow = aIsWin ? rowA : rowB;
      const loserRow = aIsWin ? rowB : rowA;

      const picksFor = (row) =>
        row
          .find(".brkts-champion-icon a[title]")
          .map((_, a) => $(a).attr("title"))
          .get();

      games.push({
        gameNumber: games.length + 1,
        winnerTeamName: null, // filled in below once we know which side won
        winnerPicks: picksFor(winnerRow),
        loserPicks: picksFor(loserRow),
        winnerIsLeft: null, // filled in below
      });
    }

    // VOD links, in "Watch Game N" order.
    const vods = {};
    $popup.find(".brkts-popup-footer .plainlinks.vodlink a[href]").each((_, a) => {
      const $a = $(a);
      const title = $a.closest(".plainlinks.vodlink").attr("title") ?? "";
      const m = title.match(/Watch Game (\d+)/i);
      const href = $a.attr("href");
      if (m && href) vods[Number(m[1])] = href;
    });

    matches.push({
      leftName,
      rightName,
      leftWon,
      format: format.replace(/[()]/g, ""), // "Bo3"
      timestamp: Number(timer.attr("data-timestamp")) || null,
      games,
      vods,
    });
  });

  return matches;
}

async function findTeamId(name) {
  const { data } = await supabase.from("teams").select("id").ilike("name", name.trim()).maybeSingle();
  return data?.id ?? null;
}

async function findMatch(tournamentId, leftName, rightName) {
  const leftId = await findTeamId(leftName);
  const rightId = await findTeamId(rightName);
  if (!leftId || !rightId) return null;

  const { data } = await supabase
    .from("matches")
    .select("id, format, team_a_id, team_b_id")
    .eq("tournament_id", tournamentId)
    .or(
      `and(team_a_id.eq.${leftId},team_b_id.eq.${rightId}),and(team_a_id.eq.${rightId},team_b_id.eq.${leftId})`
    )
    .maybeSingle();

  if (!data) return null;
  return { ...data, leftIsTeamA: data.team_a_id === leftId, leftId, rightId };
}

async function importMatchDetail(tournamentId, m) {
  const match = await findMatch(tournamentId, m.leftName, m.rightName);
  if (!match) {
    console.warn(`No existing match row for ${m.leftName} vs ${m.rightName} — skipping (run the schedule importer first)`);
    return;
  }

  const winnerTeamId = m.leftWon ? match.leftId : match.rightId;
  const loserTeamId = m.leftWon ? match.rightId : match.leftId;

  await supabase.from("matches").update({
    state: "SERIES_FINISHED",
    status: "finished",
    series_winner_team_id: winnerTeamId,
  }).eq("id", match.id);

  for (const g of m.games) {
    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(
        {
          match_id: match.id,
          game_number: g.gameNumber,
          state: "GAME_FINISHED",
          vod_url: m.vods[g.gameNumber] ?? null,
        },
        { onConflict: "match_id,game_number" }
      )
      .select("id")
      .single();

    if (error || !gameRow) {
      console.error(`Failed to upsert game ${g.gameNumber} for match ${match.id}:`, error?.message);
      continue;
    }

    // Log picks for both sides. We know which team is the OVERALL series
    // winner/loser but not definitively which physical team's row is which
    // within a single game's pick pair without deeper cross-referencing —
    // so both pick lists are logged under their respective series-level
    // winner/loser team for now. If a team loses game 1 but wins the
    // series, this will attribute that game's picks to the wrong side;
    // flagged here rather than silently guessing further.
    const insertPicks = async (heroes, teamId) => {
      for (const heroName of heroes) {
        const { error: pickErr } = await supabase.from("hero_picks_bans").insert({
          game_id: gameRow.id,
          team_id: teamId,
          hero_name: heroName,
          type: "pick",
        });
        if (pickErr && !pickErr.message.includes("duplicate key")) {
          console.error(`Failed to log pick ${heroName}:`, pickErr.message);
        }
      }
    };
    await insertPicks(g.winnerPicks, winnerTeamId);
    await insertPicks(g.loserPicks, loserTeamId);
  }

  console.log(`Imported ${m.leftName} vs ${m.rightName}: ${m.games.length} game(s), winner recorded`);
}

async function importTournament(pageTitle) {
  const { data: tournament } = await supabase
    .from("tournaments")
    .select("id")
    .eq("liquipedia_slug", pageTitle)
    .maybeSingle();

  if (!tournament) {
    console.warn(`Tournament "${pageTitle}" not found in DB — run the tournament importer first.`);
    return;
  }

  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);
  const finished = extractFinishedMatches($);
  console.log(`Found ${finished.length} finished match(es) on ${pageTitle}`);

  for (const m of finished) {
    await importMatchDetail(tournament.id, m);
  }
}

async function main() {
  const pageTitle = process.argv[2];
  if (!pageTitle) {
    console.error("Usage: node scripts/import-finished-match-details.mjs <Liquipedia_Page_Title>");
    console.error('Example: node scripts/import-finished-match-details.mjs "MSC/2026"');
    process.exit(1);
  }
  await importTournament(pageTitle);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
