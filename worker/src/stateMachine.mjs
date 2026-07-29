import { supabase } from "./config.mjs";
import { config } from "./config.mjs";

// In-memory buffer of recent "who won" readings per game, so a single
// flickered frame can't commit a winner. Keyed by game_id.
// { [gameId]: { teamName: string, count: number } }
const winnerBuffers = new Map();

const PHASE_TO_GAME_STATE = {
  DRAFT_PICK_BAN: "DRAFT_STARTED",
  LOADING: "DRAFT_COMPLETE",
  IN_GAME: "GAME_STARTED",
  VICTORY_DEFEAT_SCREEN: "GAME_FINISHED",
  POST_GAME_STATS: "GAME_FINISHED",
};

function resolveTeamIdByName(name, teamA, teamB) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (teamA?.name && n.includes(teamA.name.toLowerCase())) return teamA.id;
  if (teamB?.name && n.includes(teamB.name.toLowerCase())) return teamB.id;
  return null;
}

/**
 * Applies one Groq detection to a match+game's state, handling:
 *  - normal phase progression (draft -> loading -> in-game -> finished)
 *  - consensus-gated winner commits (requires N agreeing frames)
 *  - advancing to the next game or SERIES_FINISHED when a series concludes
 *
 * @param {object} params
 * @param {object} params.match   row from `matches` incl. team_a/team_b {id,name}
 * @param {object} params.game    row from `games`
 * @param {object} params.detection  parsed output of groqVision.classifyFrame
 */
export async function applyDetection({ match, game, detection }) {
  const mappedGameState = PHASE_TO_GAME_STATE[detection.phase];

  // Nothing recognizable this frame — leave state untouched.
  if (!mappedGameState && detection.phase !== "LOBBY") return { updated: false };

  const updates = {};

  if (mappedGameState && mappedGameState !== game.state) {
    // Only ever move forward, never backward on a single flickered frame —
    // protects against e.g. a replay/highlight cutting back to draft screen.
    const order = ["DRAFT_STARTED", "DRAFT_COMPLETE", "GAME_STARTED", "GAME_FINISHED"];
    if (order.indexOf(mappedGameState) > order.indexOf(game.state)) {
      updates.state = mappedGameState;
      if (mappedGameState === "GAME_STARTED" && !game.started_at) {
        updates.started_at = new Date().toISOString();
      }
    }
  }

  // ── Winner detection (consensus-gated) ──
  if (detection.phase === "VICTORY_DEFEAT_SCREEN" || detection.phase === "POST_GAME_STATS") {
    const winningTeamId = resolveTeamIdByName(detection.winning_team_name, match.team_a, match.team_b);
    if (winningTeamId) {
      const buf = winnerBuffers.get(game.id);
      if (buf && buf.teamId === winningTeamId) {
        buf.count += 1;
      } else {
        winnerBuffers.set(game.id, { teamId: winningTeamId, count: 1 });
      }
      const current = winnerBuffers.get(game.id);

      if (current.count >= config.winnerConfirmationFrames && !game.winner_team_id) {
        updates.winner_team_id = winningTeamId;
        updates.state = "GAME_FINISHED";
        updates.finished_at = new Date().toISOString();
        winnerBuffers.delete(game.id);
      }
    }
  }

  if (Object.keys(updates).length === 0) return { updated: false };

  await supabase.from("games").update(updates).eq("id", game.id);

  // If this game just finished with a confirmed winner, decide whether the
  // series continues or is over.
  if (updates.winner_team_id) {
    await advanceSeries(match, game.game_number, updates.winner_team_id);
  }

  return { updated: true, updates };
}

async function advanceSeries(match, finishedGameNumber, winnerTeamId) {
  const bestOf = { BO1: 1, BO3: 3, BO5: 5 }[match.format] ?? 3;
  const winsNeeded = Math.ceil(bestOf / 2);

  const { data: games } = await supabase
    .from("games")
    .select("winner_team_id")
    .eq("match_id", match.id);

  const winsFor = (teamId) => (games ?? []).filter((g) => g.winner_team_id === teamId).length;
  const teamAWins = winsFor(match.team_a?.id);
  const teamBWins = winsFor(match.team_b?.id);

  const seriesDecided = teamAWins >= winsNeeded || teamBWins >= winsNeeded;

  if (seriesDecided) {
    const seriesWinner = teamAWins >= winsNeeded ? match.team_a?.id : match.team_b?.id;
    await supabase
      .from("matches")
      .update({ state: "SERIES_FINISHED", status: "finished", series_winner_team_id: seriesWinner })
      .eq("id", match.id);
  } else {
    // Start the next game in the series.
    const nextGameNumber = finishedGameNumber + 1;
    await supabase.from("matches").update({
      current_game_number: nextGameNumber,
      state: "DRAFT_STARTED",
    }).eq("id", match.id);

    await supabase.from("games").insert({
      match_id: match.id,
      game_number: nextGameNumber,
      state: "DRAFT_STARTED",
    });
  }
}
