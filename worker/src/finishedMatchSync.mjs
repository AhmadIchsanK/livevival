// Writes per-game winners, picks, bans, VOD links, and map the moment
// Liquipedia marks a match finished. Same selectors as
// scripts/import-finished-match-details.mjs — see that file for the full
// structural notes, confirmed against real Liquipedia bracket-page HTML
// (the owner's own paste of a live tournament page, not a hand-made
// guess — see that file's fix commit for the discrepancy this corrected).
// Adds hero_id resolution against the `heroes` table so the public site
// can show a portrait, not just text.
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

    // Each .brkts-popup-body-grid-row is ONE FULL GAME (both sides), not
    // half of one — confirmed against real Liquipedia markup (the previous
    // version paired up consecutive rows via Math.floor(i/2), which both
    // miscounted the number of games and only ever read the LEFT side's
    // data, since it took only the *first* .brkts-champion-icon/
    // .generic-label found in each row — the right side's picks and
    // result were silently dropped every time). Within one row: a
    // .generic-label for the left side's result, then a
    // .brkts-popup-body-grid-row-detail containing the left side's 5
    // picks followed by the right side's 5 picks (marked with the
    // "-right" modifier), then a second .generic-label for the right
    // side's result — in that document order. A trailing
    // .brkts-popup-comment, when present, names the map.
    const gamesByNumber = new Map();
    $popup.find(".brkts-popup-body-grid-row").each((idx, row) => {
      const $row = $(row);
      const gameNumber = idx + 1;
      const labels = $row.find(".generic-label");
      const leftIcon = $row.find(".brkts-champion-icon").not(".brkts-popup-body-element-thumbs-right").first();
      const rightIcon = $row.find(".brkts-champion-icon.brkts-popup-body-element-thumbs-right").first();
      const map = $row.find(".brkts-popup-comment b").first().text().trim() || null;

      gamesByNumber.set(gameNumber, {
        gameNumber,
        left: { picks: heroesIn($, leftIcon), won: labels.eq(0).attr("data-label-type") === "result-win" },
        right: { picks: heroesIn($, rightIcon), won: labels.eq(1).attr("data-label-type") === "result-win" },
        map,
      });
    });

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
    .select("id, format, team_a_id, team_b_id, update_source, notification_tier")
    .eq("tournament_id", tournamentId)
    .or(`and(team_a_id.eq.${leftId},team_b_id.eq.${rightId}),and(team_a_id.eq.${rightId},team_b_id.eq.${leftId})`)
    .maybeSingle();

  if (!data) return null;
  return { ...data, leftId, rightId };
}

async function insertPicksAndBans(gameId, side, teamId, matchId) {
  const insertAll = async (heroNames, type) => {
    for (const heroName of heroNames ?? []) {
      const heroId = await findHeroId(heroName);
      const { error } = await supabase.from("hero_picks_bans").insert({
        game_id: gameId,
        match_id: matchId,
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
    if (g.map) gamePayload.map = g.map;

    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(gamePayload, { onConflict: "match_id,game_number" })
      .select("id")
      .single();

    if (error || !gameRow) {
      console.error(`Failed to upsert game ${g.gameNumber} for match ${match.id}:`, error?.message);
      continue;
    }

    if (g.left) await insertPicksAndBans(gameRow.id, { picks: g.left.picks, bans: g.leftBans }, match.leftId, match.id);
    if (g.right) await insertPicksAndBans(gameRow.id, { picks: g.right.picks, bans: g.rightBans }, match.rightId, match.id);

    // Per-game "result" posts are Hot-tier-only spam per the notification_tier
    // spec — Priority gets exactly match-started + match-finished, nothing
    // per game. tier is read once below and reused for both checks in this
    // function.
    if (gameWinnerTeamId && match.notification_tier === "hot") {
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
  //
  // notification_tier gates this the same way as match_live in
  // scheduleSync.mjs: 'normal' (the default) sends nothing automatically;
  // 'priority' and 'hot' both get this match-finished recap.
  if (match.notification_tier === "normal") return;

  const winnerName = m.leftWon ? m.leftName : m.rightName;
  const leftWins = m.games.filter((g) => g.left?.won).length;
  const rightWins = m.games.filter((g) => g.right?.won).length;
  const recap = m.games
    .map((g) => {
      const leftPicks = (g.left?.picks ?? []).join(", ") || "—";
      const rightPicks = (g.right?.picks ?? []).join(", ") || "—";
      return `<b>Game ${g.gameNumber}</b>${g.map ? ` (${g.map})` : ""}\n${m.leftName}: ${leftPicks}\n${m.rightName}: ${rightPicks}`;
    })
    .join("\n\n");
  await notifyOnce(
    "match",
    match.id,
    "match_finished",
    `🏆 <b>Match finished</b>\n${m.leftName} vs ${m.rightName}\nWinner: <b>${winnerName}</b> (${Math.max(leftWins, rightWins)}-${Math.min(leftWins, rightWins)})\n${tournament.name}\n\n${recap}`
  );
}

// Accepts an optional pre-fetched `html` for the same reason documented on
// syncTournamentSchedule in scheduleSync.mjs — index.mjs fetches each
// tournament's page once per tick and passes it to both sync functions
// instead of each one independently re-fetching the identical page.
export async function syncTournamentFinishedMatches(tournament, html) {
  const pageHtml = html ?? (await fetchRenderedPage(tournament.liquipedia_slug));
  const $ = cheerio.load(pageHtml);
  const finished = extractFinishedMatches($);
  for (const m of finished) {
    await importMatchDetail(tournament, m);
  }
  return finished;
}
