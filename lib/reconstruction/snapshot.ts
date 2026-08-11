// Confirmed-state snapshot + shadow comparison (spec §26, §38, §39).
// ---------------------------------------------------------------------------
// - PublicGameState: the stable confirmed-state contract the public API serves.
//   It exposes ONLY confirmed data — never candidates or rejected observations
//   — plus a stateVersion for reconnect/missed-update detection.
// - toPublicState: derive that contract from the reducer's ConfirmedState.
// - shadowCompare: compare legacy direct-mutation state against reconstructed
//   confirmed state and report divergences, WITHOUT changing public output
//   (shadow mode). Used to build confidence before switching public reads.
import type { ConfirmedState } from "./types.ts";
import { formatNetWorth, formatTimer } from "./normalize.ts";

export type PublicPlayer = {
  playerId: string;
  teamId: string;
  kills: number;
  deaths: number;
  assists: number;
  heroName: string | null;
};

export type PublicGameState = {
  gameId: string;
  status: ConfirmedState["status"];
  timer: { seconds: number; display: string };
  teamKills: Record<string, number>;
  netWorth: Record<string, { gold: number; display: string }>;
  players: PublicPlayer[];
  objectives: { turtleTotal: number; lordTotal: number; byTeam: Record<string, { turtle: number; lord: number; tower: number }> };
  turrets: Record<string, { destroyed: number }>;
  // Monotonic — clients compare to detect missed updates on reconnect.
  stateVersion: number;
  timeline: string[];
  lastConfirmedAt: number | null;
};

export function toPublicState(s: ConfirmedState): PublicGameState {
  return {
    gameId: s.gameId,
    status: s.status,
    timer: { seconds: s.timerSeconds, display: formatTimer(s.timerSeconds) },
    teamKills: { ...s.teamKills },
    netWorth: Object.fromEntries(
      Object.entries(s.netWorth).map(([t, g]) => [t, { gold: g, display: formatNetWorth(g) }])
    ),
    players: Object.values(s.players).map((p) => ({
      playerId: p.playerId,
      teamId: p.teamId,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      heroName: p.heroName,
    })),
    objectives: {
      turtleTotal: s.objectives.turtleTotal,
      lordTotal: s.objectives.lordTotal,
      byTeam: { ...s.objectives.byTeam },
    },
    turrets: Object.fromEntries(Object.entries(s.turrets).map(([t, v]) => [t, { destroyed: v.destroyed }])),
    stateVersion: s.stateVersion,
    timeline: [...s.timeline],
    lastConfirmedAt: s.lastConfirmedAt,
  };
}

// The legacy state shape, as read directly from the existing DB tables (games /
// player_stats / objectives / net_worth). Used only for shadow comparison.
export type LegacyState = {
  timerSeconds: number | null;
  teamKills: Record<string, number>;
  netWorth: Record<string, number>;
  players: Record<string, { kills: number; deaths: number; assists: number }>;
};

export type ShadowDivergence = {
  field: string;
  legacy: unknown;
  reconstructed: unknown;
};

// Compare legacy vs reconstructed confirmed state (spec §39). Reports every
// divergence; never mutates anything. A production shadow-mode job logs these
// to build (or refute) confidence before public reads are switched over.
export function shadowCompare(legacy: LegacyState, s: ConfirmedState): ShadowDivergence[] {
  const out: ShadowDivergence[] = [];
  if (legacy.timerSeconds != null && Math.abs(legacy.timerSeconds - s.timerSeconds) > 5) {
    out.push({ field: "timer", legacy: legacy.timerSeconds, reconstructed: s.timerSeconds });
  }
  for (const t of new Set([...Object.keys(legacy.teamKills), ...Object.keys(s.teamKills)])) {
    if ((legacy.teamKills[t] ?? 0) !== (s.teamKills[t] ?? 0)) {
      out.push({ field: `teamKills:${t}`, legacy: legacy.teamKills[t] ?? 0, reconstructed: s.teamKills[t] ?? 0 });
    }
  }
  for (const t of new Set([...Object.keys(legacy.netWorth), ...Object.keys(s.netWorth)])) {
    if (Math.abs((legacy.netWorth[t] ?? 0) - (s.netWorth[t] ?? 0)) > 100) {
      out.push({ field: `netWorth:${t}`, legacy: legacy.netWorth[t] ?? 0, reconstructed: s.netWorth[t] ?? 0 });
    }
  }
  for (const pid of new Set([...Object.keys(legacy.players), ...Object.keys(s.players)])) {
    const l = legacy.players[pid];
    const r = s.players[pid];
    if (!l || !r) {
      out.push({ field: `player:${pid}`, legacy: l ?? null, reconstructed: r ? { kills: r.kills, deaths: r.deaths, assists: r.assists } : null });
      continue;
    }
    if (l.kills !== r.kills || l.deaths !== r.deaths || l.assists !== r.assists) {
      out.push({ field: `player:${pid}`, legacy: l, reconstructed: { kills: r.kills, deaths: r.deaths, assists: r.assists } });
    }
  }
  return out;
}
