// Reconciliation (spec §22) — reject state that cannot be explained by coherent
// events. Produces a report identifying exactly which constraint failed, rather
// than silently auto-correcting one field by overwriting another.
import type { ConfirmedState } from "./types.ts";

export type ReconciliationReport = {
  coherent: boolean;
  conflicts: string[];
};

export function reconcile(s: ConfirmedState): ReconciliationReport {
  const conflicts: string[] = [];

  // Per-team summed player kills/deaths.
  const teamKills: Record<string, number> = {};
  const teamDeaths: Record<string, number> = {};
  for (const pid of Object.keys(s.players)) {
    const p = s.players[pid];
    teamKills[p.teamId] = (teamKills[p.teamId] ?? 0) + p.kills;
    teamDeaths[p.teamId] = (teamDeaths[p.teamId] ?? 0) + p.deaths;
  }
  const teams = Object.keys({ ...teamKills, ...teamDeaths });

  // team A kills = team B deaths (and vice versa) — only checkable with exactly
  // two teams present.
  if (teams.length === 2) {
    const [a, b] = teams;
    if ((teamKills[a] ?? 0) !== (teamDeaths[b] ?? 0)) {
      conflicts.push(`team ${a} kills ${teamKills[a] ?? 0} != team ${b} deaths ${teamDeaths[b] ?? 0}`);
    }
    if ((teamKills[b] ?? 0) !== (teamDeaths[a] ?? 0)) {
      conflicts.push(`team ${b} kills ${teamKills[b] ?? 0} != team ${a} deaths ${teamDeaths[a] ?? 0}`);
    }
  }

  // player kills sum to team kills (the confirmed team-kill counter).
  for (const t of Object.keys(s.teamKills)) {
    const summed = teamKills[t] ?? 0;
    // Strict equality in BOTH directions: the counter under the sum means
    // player kills were lost; the counter OVER the sum means kills were
    // fabricated without player attribution (the live-run orphan-kill bug).
    // Only checked when the team has player rows to reconcile against — a
    // team-kills reading with no per-player data yet is not a conflict.
    if (Object.values(s.players).some((p) => p.teamId === t)) {
      if (s.teamKills[t] < summed) {
        conflicts.push(`team ${t} counter ${s.teamKills[t]} < summed player kills ${summed}`);
      } else if (s.teamKills[t] > summed) {
        conflicts.push(`team ${t} counter ${s.teamKills[t]} > summed player kills ${summed} (unattributed kills)`);
      }
    }
  }

  // player deaths cannot exceed enemy team kills.
  if (teams.length === 2) {
    const [a, b] = teams;
    for (const pid of Object.keys(s.players)) {
      const p = s.players[pid];
      const enemyKills = p.teamId === a ? teamKills[b] ?? 0 : teamKills[a] ?? 0;
      if (p.deaths > enemyKills) {
        conflicts.push(`player ${pid} deaths ${p.deaths} > enemy kills ${enemyKills}`);
      }
    }
  }

  // objective counts within legal caps.
  if (s.objectives.turtleTotal > 4) conflicts.push(`turtleTotal ${s.objectives.turtleTotal} > 4`);
  for (const t of Object.keys(s.turrets)) {
    if (s.turrets[t].destroyed > 9) conflicts.push(`team ${t} turrets ${s.turrets[t].destroyed} > 9`);
  }

  return { coherent: conflicts.length === 0, conflicts };
}
