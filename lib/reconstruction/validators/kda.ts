// K/D/A validator (spec §4, §14, §22) — game-level relationship reconstruction.
// ---------------------------------------------------------------------------
// The spec's relationships:
//   - kills/deaths/assists are monotonic within a game (never decrease)
//   - team A kills = team B deaths, and vice versa
//   - sum of a team's player kills = that team's team kills
//   - a player's deaths cannot exceed the enemy team's total kills
//   - one kill event = 1 killer + 1 victim + 0..4 assists
//   - prefer atomic kill-event reconstruction; never publish a partial,
//     impossible K/D/A update
//
// This validator works on a WHOLE-TICK batch of per-player readings so the
// cross-player relationships can be checked together (spec §4: "validate all
// affected players together"), producing a per-player decision plus a batch
// reconciliation verdict. It is pure: no I/O, no persistence.
import type { PlayerId, TeamId, ValidationResult } from "../types.ts";

export type PlayerKda = { kills: number; deaths: number; assists: number };

export type PlayerKdaReading = {
  playerId: PlayerId;
  teamId: TeamId;
  reading: PlayerKda;
};

export type KdaContext = {
  // Last confirmed per-player KDA (playerId → value), for monotonic checks.
  confirmed: Map<string, PlayerKda>;
  // Which team each player belongs to (playerId → teamId).
  teamOf: Map<string, string>;
  teamAId: TeamId;
  teamBId: TeamId;
};

// Per-tick spike ceilings. A single garbled digit (2 → 22) is far more likely
// than this many events in one ~5s capture, and without a ceiling that garbled
// value commits and is then frozen forever by the monotonic guard. Generous
// enough that real fast play (a savage is 5 kills) never trips it.
export const MAX_KILL_GAIN_PER_TICK = 10;
export const MAX_DEATH_GAIN_PER_TICK = 10;
export const MAX_ASSIST_GAIN_PER_TICK = 15;

export type KdaDecision = {
  playerId: PlayerId;
  result: ValidationResult<PlayerKda>;
  heldBack: string[]; // human reasons a field was clamped/rejected
};

export type KdaBatchResult = {
  decisions: KdaDecision[];
  // Confirmed per-player values after all guards (playerId → value). These are
  // what the reducer/events should consume.
  confirmedValues: Map<string, PlayerKda>;
  reconciliation: KdaReconciliation;
};

export type KdaReconciliation = {
  coherent: boolean;
  // teamId → summed player kills after guards
  teamKills: Record<string, number>;
  // teamId → summed player deaths after guards
  teamDeaths: Record<string, number>;
  conflicts: string[];
};

function clampField(
  read: number,
  stored: number | undefined,
  maxGain: number,
  name: string,
  heldBack: string[]
): number {
  const floor = stored ?? 0;
  if (stored != null && read < stored) {
    heldBack.push(`${name} ${read} below confirmed ${stored} (never-decreases)`);
    return stored;
  }
  if (read - floor > maxGain) {
    heldBack.push(`${name} +${read - floor} in one tick exceeds ${maxGain} cap`);
    return floor + maxGain;
  }
  return read;
}

// Validate a whole tick's player KDA readings together.
export function validateKdaBatch(
  readings: PlayerKdaReading[],
  ctx: KdaContext
): KdaBatchResult {
  // Step 1 — per-player monotonic + spike clamp, computed for everyone first
  // so the cross-player checks below run against candidate values, not a
  // half-updated snapshot.
  const clamped = new Map<string, { teamId: string; v: PlayerKda; heldBack: string[] }>();
  for (const r of readings) {
    const stored = ctx.confirmed.get(r.playerId);
    const heldBack: string[] = [];
    const v: PlayerKda = {
      kills: clampField(r.reading.kills, stored?.kills, MAX_KILL_GAIN_PER_TICK, "kills", heldBack),
      deaths: clampField(r.reading.deaths, stored?.deaths, MAX_DEATH_GAIN_PER_TICK, "deaths", heldBack),
      assists: clampField(r.reading.assists, stored?.assists, MAX_ASSIST_GAIN_PER_TICK, "assists", heldBack),
    };
    clamped.set(r.playerId, { teamId: r.teamId, v, heldBack });
  }

  // Team kill totals from candidates where a player was read this tick, and
  // from confirmed values otherwise. Used for the deaths-vs-enemy-kills rule.
  const teamKillTotal = (teamId: string): number => {
    let sum = 0;
    for (const [pid, team] of ctx.teamOf) {
      if (team !== teamId) continue;
      const c = clamped.get(pid);
      sum += c ? c.v.kills : ctx.confirmed.get(pid)?.kills ?? 0;
    }
    return sum;
  };

  // Step 2 — §4 "player deaths cannot exceed enemy team kills": an impossible
  // relationship, so roll the offending player's deaths back to the last
  // possible value (spec §22: reject, don't overwrite another field). Kills and
  // assists on the same read are independent and stay.
  for (const [pid, entry] of clamped) {
    const enemyTeamId = entry.teamId === ctx.teamAId ? ctx.teamBId : ctx.teamAId;
    const enemyKills = teamKillTotal(enemyTeamId);
    if (entry.v.deaths > enemyKills) {
      const stored = ctx.confirmed.get(pid)?.deaths ?? 0;
      entry.heldBack.push(
        `deaths ${entry.v.deaths} exceed enemy team kills ${enemyKills} (impossible)`
      );
      entry.v = { ...entry.v, deaths: Math.min(entry.v.deaths, Math.max(stored, enemyKills)) };
    }
  }

  // Step 3 — build decisions + confirmed values.
  const decisions: KdaDecision[] = [];
  const confirmedValues = new Map<string, PlayerKda>();
  for (const r of readings) {
    const entry = clamped.get(r.playerId)!;
    confirmedValues.set(r.playerId, entry.v);
    decisions.push({
      playerId: r.playerId,
      heldBack: entry.heldBack,
      result:
        entry.heldBack.length === 0
          ? { status: "confirmed", value: entry.v, reason: "ok" }
          : { status: "candidate", value: entry.v, reason: entry.heldBack.join("; ") },
    });
  }

  // Step 4 — reconciliation report (spec §22). Includes confirmed players not
  // in this tick, so the team totals reflect the whole game state.
  const teamKills: Record<string, number> = {};
  const teamDeaths: Record<string, number> = {};
  for (const teamId of [ctx.teamAId, ctx.teamBId]) {
    let k = 0;
    let d = 0;
    for (const [pid, team] of ctx.teamOf) {
      if (team !== teamId) continue;
      const c = confirmedValues.get(pid);
      const base = c ?? ctx.confirmed.get(pid);
      k += base?.kills ?? 0;
      d += base?.deaths ?? 0;
    }
    teamKills[teamId] = k;
    teamDeaths[teamId] = d;
  }
  const conflicts: string[] = [];
  // team A kills should equal team B deaths, and vice versa.
  if (teamKills[ctx.teamAId] !== teamDeaths[ctx.teamBId]) {
    conflicts.push(
      `team A kills ${teamKills[ctx.teamAId]} != team B deaths ${teamDeaths[ctx.teamBId]}`
    );
  }
  if (teamKills[ctx.teamBId] !== teamDeaths[ctx.teamAId]) {
    conflicts.push(
      `team B kills ${teamKills[ctx.teamBId]} != team A deaths ${teamDeaths[ctx.teamAId]}`
    );
  }

  return {
    decisions,
    confirmedValues,
    reconciliation: { coherent: conflicts.length === 0, teamKills, teamDeaths, conflicts },
  };
}

// Validate a team-kills OCR reading (the aggregate tracker) against the summed
// per-player kills already confirmed for that team. A team-kill count is never
// legitimately far ahead of what its players have been individually credited
// (spec §4 "player kills sum to team kills"). Some lag is normal (independent
// OCR regions), so a large jump is held as candidate, not silently trusted.
export const MAX_TEAM_KILL_JUMP = 10;

export function validateTeamKills(
  reading: number | null,
  confirmedTeamKills: number | null,
  summedPlayerKills: number
): ValidationResult<number> {
  if (reading == null) return { status: "missing", value: null, reason: "no reading" };
  const floor = Math.max(confirmedTeamKills ?? 0, summedPlayerKills);
  if (confirmedTeamKills != null && reading < confirmedTeamKills) {
    return { status: "rejected", value: confirmedTeamKills, reason: "never-decreases" };
  }
  if (reading - floor > MAX_TEAM_KILL_JUMP) {
    return {
      status: "candidate",
      value: floor,
      reason: `team kills ${reading} jumps ${reading - floor} over floor ${floor}`,
    };
  }
  return { status: "confirmed", value: Math.max(reading, floor), reason: "ok" };
}
