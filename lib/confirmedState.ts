// Confirmed-state assembly for the public API (spec §26, §27).
// ---------------------------------------------------------------------------
// Serves the stable PublicGameState contract. Two sources, selected by flag:
//
//   1. LEGACY-DERIVED (default, always available): read the already-persisted,
//      already-validated values from the existing games / player_stats /
//      objectives / net_worth_snapshots tables and shape them into the
//      contract. These DB values ARE the confirmed values under the current
//      system, so this is correct and safe today — and it means the public
//      contract works before the reconstruction migration is applied.
//
//   2. RECONSTRUCTION SNAPSHOT (flag RECONSTRUCTION_PUBLIC_READS): read the
//      materialized confirmed_game_state row produced by the engine. Flip only
//      after shadow-mode acceptance.
//
// Crucially, both paths read PERSISTED values. During an OCR gap nothing is
// written, so the last confirmed values simply persist — the API never emits
// zero/undefined just because a live reading is momentarily missing (spec §27).
import { createClient } from "@supabase/supabase-js";
import { flags } from "@/lib/featureFlags";
import type { PublicGameState } from "@/lib/reconstruction/snapshot";
import { formatNetWorth, formatTimer } from "@/lib/reconstruction/normalize";

function serverSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

export type MatchStatePayload = {
  matchId: string;
  source: "reconstruction" | "legacy";
  generatedAt: string;
  currentGameId: string | null;
  games: PublicGameState[];
};

type GameRow = {
  id: string;
  game_number: number;
  status: string;
  state: string;
  winner_team_id: string | null;
  current_time_seconds: number | null;
  team_a_kills_override: number | null;
  team_b_kills_override: number | null;
};

// Map the legacy match_state enum to the reconstruction GameStatus.
function statusFromGame(g: GameRow): PublicGameState["status"] {
  if (g.status === "finished" || g.state === "GAME_FINISHED" || g.state === "SERIES_FINISHED") return "finished";
  if (g.state === "GAME_STARTED" || g.state === "TECHNICAL_PAUSE") return "in_progress";
  return "not_started";
}

// Build the confirmed-state contract for one match by reading the legacy tables.
export async function getMatchState(matchId: string): Promise<MatchStatePayload | null> {
  const supabase = serverSupabase();

  const { data: matchRow } = await supabase
    .from("matches")
    .select("id, team_a_id, team_b_id")
    .eq("id", matchId)
    .maybeSingle();
  if (!matchRow) return null;
  const teamAId = (matchRow as { team_a_id: string | null }).team_a_id;
  const teamBId = (matchRow as { team_b_id: string | null }).team_b_id;

  const { data: gameRows } = await supabase
    .from("games")
    .select("id, game_number, status, state, winner_team_id, current_time_seconds, team_a_kills_override, team_b_kills_override")
    .eq("match_id", matchId)
    .order("game_number", { ascending: true });
  const games = ((gameRows as GameRow[]) ?? []);
  if (games.length === 0) {
    return { matchId, source: "legacy", generatedAt: new Date().toISOString(), currentGameId: null, games: [] };
  }

  // If reconstruction public reads are enabled, prefer the materialized
  // snapshot per game, falling back to legacy derivation when absent.
  const snapshotByGame = new Map<string, PublicGameState>();
  if (flags.reconstructionPublicReads) {
    const { data: snaps } = await supabase
      .from("confirmed_game_state")
      .select("game_id, state")
      .in("game_id", games.map((g) => g.id));
    for (const row of (snaps as { game_id: string; state: PublicGameState }[]) ?? []) {
      if (row.state && typeof row.state === "object") snapshotByGame.set(row.game_id, row.state);
    }
  }

  const gameIds = games.map((g) => g.id);
  const [{ data: stats }, { data: objectives }, { data: netWorth }] = await Promise.all([
    supabase.from("player_stats").select("game_id, player_id, hero_name, kills, deaths, assists, player:players!player_stats_player_id_fkey(ign, team_id)").in("game_id", gameIds),
    supabase.from("objectives").select("game_id, team_id, type").in("game_id", gameIds),
    supabase.from("net_worth_snapshots").select("game_id, team_a_gold, team_b_gold, minute_mark").in("game_id", gameIds).order("minute_mark", { ascending: false }),
  ]);

  const statRows = (stats as any[]) ?? [];
  const objRows = (objectives as { game_id: string; team_id: string; type: string }[]) ?? [];
  const nwRows = (netWorth as { game_id: string; team_a_gold: number; team_b_gold: number }[]) ?? [];

  const out: PublicGameState[] = games.map((g) => {
    if (snapshotByGame.has(g.id)) return snapshotByGame.get(g.id)!;

    const gStats = statRows.filter((s) => s.game_id === g.id);
    const players = gStats.map((s) => ({
      playerId: s.player_id,
      teamId: s.player?.team_id ?? "",
      kills: s.kills ?? 0,
      deaths: s.deaths ?? 0,
      assists: s.assists ?? 0,
      heroName: s.hero_name ?? null,
    }));

    // Team kills = max(override, summed player kills) — the same reconciliation
    // the admin/public pages already use, so all three surfaces agree.
    const teamKills: Record<string, number> = {};
    if (teamAId) teamKills[teamAId] = Math.max(g.team_a_kills_override ?? 0, players.filter((p) => p.teamId === teamAId).reduce((s, p) => s + p.kills, 0));
    if (teamBId) teamKills[teamBId] = Math.max(g.team_b_kills_override ?? 0, players.filter((p) => p.teamId === teamBId).reduce((s, p) => s + p.kills, 0));

    const latestNw = nwRows.find((n) => n.game_id === g.id);
    const netWorthOut: Record<string, { gold: number; display: string }> = {};
    if (latestNw && teamAId) netWorthOut[teamAId] = { gold: latestNw.team_a_gold, display: formatNetWorth(latestNw.team_a_gold) };
    if (latestNw && teamBId) netWorthOut[teamBId] = { gold: latestNw.team_b_gold, display: formatNetWorth(latestNw.team_b_gold) };

    const byTeam: Record<string, { turtle: number; lord: number; tower: number }> = {};
    let turtleTotal = 0;
    let lordTotal = 0;
    for (const o of objRows.filter((o) => o.game_id === g.id)) {
      const bt = (byTeam[o.team_id] = byTeam[o.team_id] ?? { turtle: 0, lord: 0, tower: 0 });
      if (o.type === "turtle") { bt.turtle += 1; turtleTotal += 1; }
      else if (o.type === "lord") { bt.lord += 1; lordTotal += 1; }
      else if (o.type === "tower") bt.tower += 1;
    }

    const timerSeconds = g.current_time_seconds ?? 0;
    // A monotonic-ish version derived from persisted magnitudes — enough for a
    // public client to detect "something changed" between polls without the
    // reconstruction snapshot's true event sequence.
    const stateVersion =
      timerSeconds +
      Object.values(teamKills).reduce((s, v) => s + v, 0) * 1000 +
      (turtleTotal + lordTotal) * 100 +
      players.reduce((s, p) => s + p.kills + p.deaths + p.assists, 0);

    return {
      gameId: g.id,
      status: statusFromGame(g),
      timer: { seconds: timerSeconds, display: formatTimer(timerSeconds) },
      teamKills,
      netWorth: netWorthOut,
      players,
      objectives: { turtleTotal, lordTotal, byTeam },
      turrets: Object.fromEntries(
        Object.entries(byTeam).map(([t, v]) => [t, { destroyed: v.tower }])
      ),
      stateVersion,
      timeline: [],
      lastConfirmedAt: null,
    };
  });

  const currentGame = games.find((g) => statusFromGame(g) === "in_progress") ?? games[games.length - 1];
  return {
    matchId,
    source: flags.reconstructionPublicReads ? "reconstruction" : "legacy",
    generatedAt: new Date().toISOString(),
    currentGameId: currentGame?.id ?? null,
    games: out,
  };
}
