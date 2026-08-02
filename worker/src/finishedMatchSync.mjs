// Writes per-game winners, picks, bans, and VOD links the moment Liquipedia
// marks a match finished. Same selectors as
// scripts/import-finished-match-details.mjs (confirmed against a real
// api.php response for MSC/2026) — see that file for the full structural
// notes. Adds hero_id resolution against the `heroes` table so the public
// site can show a portrait, not just text.
import * as cheerio from "cheerio";
import { supabase } from "./config.mjs";
import { fetchRenderedPage } from "./liquipediaClient.mjs";
import { notifyOnce } from "./telegram.mjs";

export function isRightSide($, championIconEl) {
  return $(championIconEl).hasClass("brkts-popup-body-element-thumbs-right");
}

export function heroesIn($, containerEl) {
  return $(containerEl).find("a[title]").map((_, a) => $(a).attr("title")).get();
}

export function extractFinishedMatches($) {
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

    const pickRows = $popup.find(".brkts-popup-body-grid-row");
    const gamesByNumber = new Map();
    for (let i = 0; i < pickRows.length; i++) {
      const $row = $(pickRows[i]);
      const gameNumber = Math.floor(i / 2) + 1;
      const championIcon = $row.find(".brkts-champion-icon").first();
      if (championIcon.length === 0) continue;

      const side = isRightSide($, championIcon) ? "right" : "left";
      const label = $row.find(".generic-label").attr("data-label-type");
      const heroes = heroesIn($, championIcon);

      const game = gamesByNumber.get(gameNumber) ?? { gameNumber, left: null, right: null };
      const entry = { picks: heroes, won: label === "result-win" };
      if (side === "right") game.right = entry;
      else game.left = entry;
      gamesByNumber.set(gameNumber, game);
    }

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

const heroIdCache = new Map();
async function findHeroId(heroName) {
  const key = heroName.toLowerCase();
  if (heroIdCache.has(key)) return heroIdCache.get(key);

  const { data: byName } = await supabase.from("heroes").select("id").ilike("name", heroName).maybeSingle();
  if (byName) {
    heroIdCache.set(key, byName.id);
    return byName.id;
  }

  const { data: byAlias } = await supabase.from("heroes").select("id").contains("aliases", [heroName]).maybeSingle();
  heroIdCache.set(key, byAlias?.id ?? null);
  return byAlias?.id ?? null;
}

async function findMatch(tournamentId, leftName, rightName) {
  const leftId = await findTeamId(leftName);
  const rightId = await findTeamId(rightName);
  if (!leftId || !rightId) return null;

  const { data } = await supabase
    .from("matches")
    .select("id, format, team_a_id, team_b_id, update_source")
    .eq("tournament_id", tournamentId)
    .or(`and(team_a_id.eq.${leftId},team_b_id.eq.${rightId}),and(team_a_id.eq.${rightId},team_b_id.eq.${leftId})`)
    .maybeSingle();

  if (!data) return null;
  return { ...data, leftId, rightId };
}

async function insertPicksAndBans(gameId, side, teamId) {
  const insertAll = async (heroNames, type) => {
    for (const heroName of heroNames ?? []) {
      const heroId = await findHeroId(heroName);
      const { error } = await supabase.from("hero_picks_bans").insert({
        game_id: gameId,
        team_id: teamId,
        hero_name: heroName,
        hero_id: heroId,
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

async function importMatchDetail(tournament, m) {
  const match = await findMatch(tournament.id, m.leftName, m.rightName);
  if (!match || match.update_source === "local_ocr") return;

  const seriesWinnerTeamId = m.leftWon ? match.leftId : match.rightId;

  await supabase.from("matches").update({
    state: "SERIES_FINISHED",
    status: "finished",
    series_winner_team_id: seriesWinnerTeamId,
  }).eq("id", match.id);

  for (const g of m.games) {
    const gameWinnerTeamId = g.left?.won ? match.leftId : g.right?.won ? match.rightId : null;

    const gamePayload = {
      match_id: match.id,
      game_number: g.gameNumber,
      state: "GAME_FINISHED",
      status: "finished",
      winner_team_id: gameWinnerTeamId,
    };
    // Only set vod_url when Liquipedia actually has one — omitting the key
    // (rather than writing null) leaves an existing value alone on
    // conflict, so this can't clobber a link the YouTube fallback already
    // found (youtubeVodFallback.mjs) on a later tick.
    if (m.vods[g.gameNumber]) gamePayload.vod_url = m.vods[g.gameNumber];

    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(gamePayload, { onConflict: "match_id,game_number" })
      .select("id")
      .single();

    if (error || !gameRow) {
      console.error(`Failed to upsert game ${g.gameNumber} for match ${match.id}:`, error?.message);
      continue;
    }

    if (g.left) await insertPicksAndBans(gameRow.id, { picks: g.left.picks, bans: g.leftBans }, match.leftId);
    if (g.right) await insertPicksAndBans(gameRow.id, { picks: g.right.picks, bans: g.rightBans }, match.rightId);

    if (gameWinnerTeamId) {
      const winnerName = g.left?.won ? m.leftName : m.rightName;
      await notifyOnce(
        "game",
        gameRow.id,
        "game_result",
        `🎮 <b>Game ${g.gameNumber} result</b>\n${m.leftName} vs ${m.rightName}\nWinner: <b>${winnerName}</b>\n${tournament.name}`
      );
    }
  }

  // Liquipedia only exposes per-game data once the whole series is marked
  // finished (see the module comment on extractFinishedMatches) — so the
  // per-game notifications above and this match-finished one land in the
  // same tick for a normal match, not spread out live as each game ends.
  // notifyOnce's own dedup (not a local check here — findMatch()'s select
  // doesn't fetch status/state) is what stops this firing every tick.
  const winnerName = m.leftWon ? m.leftName : m.rightName;
  await notifyOnce(
    "match",
    match.id,
    "match_finished",
    `🏆 <b>Match finished</b>\n${m.leftName} vs ${m.rightName}\nWinner: <b>${winnerName}</b>\n${tournament.name}`
  );
}

export async function syncTournamentFinishedMatches(tournament) {
  const html = await fetchRenderedPage(tournament.liquipedia_slug);
  const $ = cheerio.load(html);
  const finished = extractFinishedMatches($);
  for (const m of finished) {
    await importMatchDetail(tournament, m);
  }
  return finished;
}
