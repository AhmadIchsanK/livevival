// Livevival — every 30 minutes, re-checks every recent Hot (OCR-tracked)
// match against Liquipedia's own bracket-page record and corrects the
// score/winner/game-state and hero picks/bans if Liquipedia disagrees with
// what the live OCR tracker recorded. The owner's own framing: "Always
// update match result every 30 minutes and can overwrite the hot match with
// Liquipedia result to make it more accurate. Only things that didn't have
// to overwrite from hot match were team kills, player KDA, moment list, and
// screenshot."
//
// So this writes to exactly: matches.state/status/series_winner_team_id,
// games.state/winner_team_id/vod_url (never clobbering a manually-set VOD —
// same rule as import-finished-match-details.mjs), and hero_picks_bans
// (reconciled by position, not delete+reinsert — see sync-hot-match-picks-
// bans.mjs's module comment for why). It NEVER touches player_stats
// (kills/deaths/assists), key_moments, or anything screenshot-related —
// those tables are never even queried here, so there's no path for this
// script to accidentally overwrite them.
//
// Scope is bounded to avoid hammering Liquipedia every 30 minutes forever:
// only Hot matches that are still "live" (need the score to catch up) or
// were scheduled within the last RECENT_WINDOW_DAYS (already finished, but
// worth a few follow-up passes in case Liquipedia's own record lagged
// behind the live OCR session) get checked. Older finished Hot matches are
// left alone — by the time a match is a week old, both sides' records have
// long since settled.

import { createClient } from "@supabase/supabase-js";
import { sleep } from "./_liquipedia.mjs";
import { findMatchOnLiquipedia, reconcileGroup } from "./sync-hot-match-picks-bans.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RECENT_WINDOW_DAYS = 7;
const norm = (s) => (s ?? "").trim().toLowerCase();

async function syncOneMatch(match) {
  const tournament = Array.isArray(match.tournament) ? match.tournament[0] : match.tournament;
  const teamA = Array.isArray(match.team_a) ? match.team_a[0] : match.team_a;
  const teamB = Array.isArray(match.team_b) ? match.team_b[0] : match.team_b;
  if (!tournament?.liquipedia_slug || !teamA || !teamB) {
    console.log(`Match ${match.id} is missing tournament/team data — skipping.`);
    return;
  }

  console.log(`\n=== ${teamA.name} vs ${teamB.name} (${tournament.liquipedia_slug}) ===`);
  const scraped = await findMatchOnLiquipedia(tournament.liquipedia_slug, teamA.name, teamB.name, match.scheduled_at);
  if (!scraped) {
    console.log("No finished-match record on Liquipedia yet — nothing to sync.");
    return;
  }

  const leftIsTeamA = norm(scraped.leftName) === norm(teamA.name);
  const sideFor = (teamId, g) => (leftIsTeamA ? (teamId === teamA.id ? g.left : g.right) : teamId === teamA.id ? g.right : g.left);
  const bansFor = (teamId, g) => (leftIsTeamA ? (teamId === teamA.id ? g.leftBans : g.rightBans) : teamId === teamA.id ? g.rightBans : g.leftBans);

  // Series-level result — only overwrite matches.state/status/winner once
  // Liquipedia itself reports the series finished (extractFinishedMatches
  // only ever returns matches with a `data-finished` timer in the first
  // place, so `scraped` existing at all already means this).
  const seriesWinnerTeamId = scraped.leftWon === leftIsTeamA ? teamA.id : teamB.id;
  if (match.status !== "finished" || match.series_winner_team_id !== seriesWinnerTeamId) {
    await supabase
      .from("matches")
      .update({ state: "SERIES_FINISHED", status: "finished", series_winner_team_id: seriesWinnerTeamId })
      .eq("id", match.id);
    console.log(`Updated series result: winner = ${seriesWinnerTeamId === teamA.id ? teamA.name : teamB.name}`);
  }

  for (const g of scraped.games) {
    const gameWinnerTeamId = g.left?.won === true ? (leftIsTeamA ? teamA.id : teamB.id) : g.right?.won === true ? (leftIsTeamA ? teamB.id : teamA.id) : null;

    const { data: existingGame } = await supabase
      .from("games")
      .select("id, vod_url_source")
      .eq("match_id", match.id)
      .eq("game_number", g.gameNumber)
      .maybeSingle();
    const isManualVod = existingGame?.vod_url_source === "manual";

    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(
        {
          match_id: match.id,
          game_number: g.gameNumber,
          state: "GAME_FINISHED",
          winner_team_id: gameWinnerTeamId,
          ...(isManualVod ? {} : scraped.vods?.[g.gameNumber] ? { vod_url: scraped.vods[g.gameNumber] } : {}),
        },
        { onConflict: "match_id,game_number" }
      )
      .select("id")
      .single();

    if (error || !gameRow) {
      console.error(`Failed to upsert game ${g.gameNumber}:`, error?.message);
      continue;
    }

    const groups = [
      [teamA.id, "pick", sideFor(teamA.id, g)?.picks ?? []],
      [teamB.id, "pick", sideFor(teamB.id, g)?.picks ?? []],
      [teamA.id, "ban", bansFor(teamA.id, g) ?? []],
      [teamB.id, "ban", bansFor(teamB.id, g) ?? []],
    ];
    for (const [teamId, type, scrapedNames] of groups) {
      await reconcileGroup(gameRow.id, match.id, teamId, type, scrapedNames);
    }
  }

  console.log(`Done syncing ${teamA.name} vs ${teamB.name}.`);
}

async function main() {
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: matches, error } = await supabase
    .from("matches")
    .select(
      `id, status, scheduled_at, series_winner_team_id,
       tournament:tournaments(liquipedia_slug),
       team_a:teams!matches_team_a_id_fkey(id, name),
       team_b:teams!matches_team_b_id_fkey(id, name)`
    )
    .eq("update_source", "local_ocr")
    .in("status", ["live", "finished"])
    .gte("scheduled_at", recentCutoff);

  if (error) throw error;

  console.log(`Found ${matches?.length ?? 0} recent Hot match(es) eligible for a Liquipedia sync pass.`);
  for (const match of matches ?? []) {
    try {
      await syncOneMatch(match);
    } catch (err) {
      console.error(`Failed syncing match ${match.id}:`, err.message);
    }
    await sleep(2000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
