// Livevival — imports finished-match detail (per-game VOD links, winners,
// champion picks, AND bans) from a tournament's Liquipedia bracket page.
//
// Structure this relies on (confirmed against a real api.php response for
// MSC/2026):
//
//   .brkts-popup-container.brkts-match-info-popup   one block per match
//     .timer-object[data-timestamp][data-finished]  schedule + completion
//     .match-info-header-opponent(-left)             the two team names;
//       "-left" marks the LEFT side. Side (left/right) is the reliable way
//       to attribute picks/bans to a physical team — do NOT assume the
//       left side always won or always picks first.
//     .match-info-header-scoreholder-lower            "(BoX)" format tag
//
//     Picks — one row PER TEAM PER GAME (two rows per game):
//     .brkts-popup-body-grid-row
//       .generic-label[data-label-type="result-win"|"result-loss"]  who
//         won THAT SPECIFIC GAME (not necessarily the series winner)
//       .brkts-champion-icon                          5 heroes that row's
//         team picked; if this div also has the class
//         "brkts-popup-body-element-thumbs-right" the row belongs to the
//         RIGHT-side team, otherwise the LEFT-side team.
//
//     Bans — one row PER GAME (both teams together), inside a collapsed
//     panel that's still present in the static HTML:
//     .brkts-popup-veto-wrapper .brkts-popup-veto-row
//       first  .brkts-champion-icon (no "-right" class) = LEFT team's bans
//       second .brkts-champion-icon.brkts-popup-body-element-thumbs-right
//              = RIGHT team's bans
//       rows appear in game order (row 1 = game 1, row 2 = game 2, ...)
//
//     .brkts-popup-footer .plainlinks.vodlink a[href][title="Watch Game N"]
//       per-game VOD link. Multiple games can share one base video with a
//       "?&=<seconds>" offset instead of separate URLs — both are stored
//       as-is, either way the site can link straight to the right moment.
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

function isRightSide($, championIconEl) {
  return $(championIconEl).hasClass("brkts-popup-body-element-thumbs-right");
}

function heroesIn($, containerEl) {
  return $(containerEl)
    .find("a[title]")
    .map((_, a) => $(a).attr("title"))
    .get();
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
    const format = $popup.find(".match-info-header-scoreholder-lower").text().trim().replace(/[()]/g, "");

    // ── Picks: two rows per game (one per side), side determined by the
    // "-right" class rather than by win/loss, since a team can lose game 1
    // and still win the series — win/loss alone can't tell us WHICH side
    // a row belongs to.
    const pickRows = $popup.find(".brkts-popup-body-grid-row");
    const gamesByNumber = new Map();
    for (let i = 0; i < pickRows.length; i++) {
      const $row = $(pickRows[i]);
      const gameNumber = Math.floor(i / 2) + 1;
      const championIcon = $row.find(".brkts-champion-icon").first();
      if (championIcon.length === 0) continue;

      const side = isRightSide($, championIcon) ? "right" : "left";
      const label = $row.find(".generic-label").attr("data-label-type"); // result-win / result-loss
      const heroes = heroesIn($, championIcon);

      const game = gamesByNumber.get(gameNumber) ?? { gameNumber, left: null, right: null };
      const entry = { picks: heroes, won: label === "result-win" };
      if (side === "right") game.right = entry;
      else game.left = entry;
      gamesByNumber.set(gameNumber, game);
    }

    // ── Bans: one row per game, both sides together.
    $popup.find(".brkts-popup-veto-wrapper .brkts-popup-veto-row").each((rowIndex, row) => {
      const $row = $(row);
      const gameNumber = rowIndex + 1;
      const rightIcon = $row.find(".brkts-champion-icon.brkts-popup-body-element-thumbs-right").first();
      const leftIcon = $row.find(".brkts-champion-icon").not(".brkts-popup-body-element-thumbs-right").first();

      const game = gamesByNumber.get(gameNumber) ?? { gameNumber, left: null, right: null };
      game.leftBans = heroesIn($, leftIcon);
      game.rightBans = heroesIn($, rightIcon);
      gamesByNumber.set(gameNumber, game);
    });

    // ── VOD links, in "Watch Game N" order.
    const vods = {};
    $popup.find(".brkts-popup-footer .plainlinks.vodlink").each((_, span) => {
      const $span = $(span);
      const title = $span.attr("title") ?? "";
      const m = title.match(/Watch Game (\d+)/i);
      const href = $span.find("a[href]").attr("href");
      if (m && href) vods[Number(m[1])] = href;
    });

    matches.push({
      leftName,
      rightName,
      leftWon,
      format,
      timestamp: Number(timer.attr("data-timestamp")) || null,
      games: Array.from(gamesByNumber.values()).sort((a, b) => a.gameNumber - b.gameNumber),
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
  return { ...data, leftId, rightId };
}

async function insertPicksAndBans(gameId, side, teamId) {
  const insertAll = async (heroes, type) => {
    for (const heroName of heroes ?? []) {
      const { error } = await supabase.from("hero_picks_bans").insert({
        game_id: gameId,
        team_id: teamId,
        hero_name: heroName,
        type,
      });
      if (error && !error.message.includes("duplicate key")) {
        console.error(`Failed to log ${type} ${heroName}:`, error.message);
      }
    }
  };
  if (side.picks) await insertAll(side.picks, "pick");
  if (side.bans) await insertAll(side.bans, "ban");
}

async function importMatchDetail(tournamentId, m) {
  const match = await findMatch(tournamentId, m.leftName, m.rightName);
  if (!match) {
    console.warn(`No existing match row for ${m.leftName} vs ${m.rightName} — skipping (run the schedule importer first)`);
    return;
  }

  const seriesWinnerTeamId = m.leftWon ? match.leftId : match.rightId;

  await supabase.from("matches").update({
    state: "SERIES_FINISHED",
    status: "finished",
    series_winner_team_id: seriesWinnerTeamId,
  }).eq("id", match.id);

  for (const g of m.games) {
    // Per-game winner comes from that game's own result-win label, NOT
    // assumed from the series winner — correctly handles reverse sweeps.
    const gameWinnerTeamId = g.left?.won ? match.leftId : g.right?.won ? match.rightId : null;

    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(
        {
          match_id: match.id,
          game_number: g.gameNumber,
          state: "GAME_FINISHED",
          winner_team_id: gameWinnerTeamId,
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

    if (g.left) await insertPicksAndBans(gameRow.id, { picks: g.left.picks, bans: g.leftBans }, match.leftId);
    if (g.right) await insertPicksAndBans(gameRow.id, { picks: g.right.picks, bans: g.rightBans }, match.rightId);
  }

  console.log(`Imported ${m.leftName} vs ${m.rightName}: ${m.games.length} game(s), picks + bans + winners recorded`);
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
    console.error('Example: node scripts/import-finished-match-details.mjs "MSC/2026/Knockout_Stage"');
    console.error("Note: bans/picks/VODs typically live on a tournament's STAGE subpages");
    console.error('(e.g. "MSC/2026/Group_Stage", "MSC/2026/Knockout_Stage"), not always the');
    console.error("top-level tournament page — run once per stage for full coverage.");
    process.exit(1);
  }
  await importTournament(pageTitle);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
