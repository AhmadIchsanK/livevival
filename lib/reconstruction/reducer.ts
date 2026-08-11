// Game-state reducer (spec §10, §19) — derives confirmed state purely from the
// confirmed event stream. Replaying the same events reproduces the same state,
// so a corrupted snapshot can always be repaired by replay.
// ---------------------------------------------------------------------------
// The reducer is the ONLY place counters change. No UI action mutates a derived
// counter without going through an event (spec §10 guardrail).
//
// GAME_FINISHED is a hard boundary (spec §19): once the game is finished (base
// destroyed or explicit finish), normal telemetry events (KILL, STAT_UPDATE,
// NET_WORTH_UPDATE, TIMER_UPDATE, objective/turret events) are ignored. Only an
// explicit audited MANUAL_CORRECTION may change state afterward.
import type {
  ConfirmedState,
  GameEvent,
  GameId,
  PlayerState,
  StatPayload,
  KillPayload,
  NetWorthPayload,
  TimerPayload,
  TurretPayload,
  CorrectionPayload,
  TeamId,
} from "./types.ts";
import { asTeamId, asPlayerId } from "./types.ts";

export function initialState(gameId: GameId): ConfirmedState {
  return {
    gameId,
    status: "not_started",
    timerSeconds: 0,
    teamKills: {},
    netWorth: {},
    players: {},
    objectives: { byTeam: {}, turtleTotal: 0, lordTotal: 0 },
    turrets: {},
    stateVersion: 0,
    timeline: [],
    lastConfirmedAt: null,
  };
}

const NORMAL_TELEMETRY: ReadonlySet<string> = new Set([
  "KILL",
  "STAT_UPDATE",
  "NET_WORTH_UPDATE",
  "TIMER_UPDATE",
  "TURTLE_SPAWNED",
  "TURTLE_KILLED",
  "LORD_SPAWNED",
  "LORD_KILLED",
  "TURRET_DESTROYED",
]);

function ensurePlayer(s: ConfirmedState, playerId: string, teamId: string): PlayerState {
  let p = s.players[playerId];
  if (!p) {
    p = { playerId: asPlayerId(playerId), teamId: asTeamId(teamId), kills: 0, deaths: 0, assists: 0, heroName: null };
    s.players[playerId] = p;
  }
  return p;
}

function recomputeTeamKills(s: ConfirmedState): void {
  const totals: Record<string, number> = {};
  for (const pid of Object.keys(s.players)) {
    const p = s.players[pid];
    totals[p.teamId] = (totals[p.teamId] ?? 0) + p.kills;
  }
  // Preserve any team with an explicit team-kills event but no per-player rows.
  for (const t of Object.keys(s.teamKills)) if (!(t in totals)) totals[t] = s.teamKills[t];
  for (const t of Object.keys(totals)) {
    s.teamKills[t] = Math.max(totals[t], s.teamKills[t] ?? 0);
  }
}

// Apply a single confirmed event to the state (mutates and returns it). Events
// must be applied in chronological order (use orderedEvents).
export function applyEvent(state: ConfirmedState, event: GameEvent): ConfirmedState {
  const s = state;
  const finished = s.status === "finished";

  // GAME_FINISHED lock — after finish, normal telemetry cannot change state.
  if (finished && NORMAL_TELEMETRY.has(event.type)) {
    return s; // ignored; final result stands (spec §19)
  }

  switch (event.type) {
    case "GAME_STARTED": {
      if (s.status === "not_started") s.status = "in_progress";
      break;
    }
    case "TIMER_UPDATE": {
      const p = event.payload as TimerPayload;
      if (p.seconds >= s.timerSeconds) s.timerSeconds = p.seconds;
      break;
    }
    case "STAT_UPDATE": {
      const p = event.payload as StatPayload;
      const player = ensurePlayer(s, p.playerId, p.teamId);
      player.kills = Math.max(player.kills, p.kills);
      player.deaths = Math.max(player.deaths, p.deaths);
      player.assists = Math.max(player.assists, p.assists);
      if (p.heroName) player.heroName = p.heroName;
      recomputeTeamKills(s);
      break;
    }
    case "KILL": {
      const p = event.payload as KillPayload;
      if (p.killerPlayerId) ensurePlayer(s, p.killerPlayerId, p.killerTeamId).kills += 1;
      if (p.victimPlayerId) ensurePlayer(s, p.victimPlayerId, p.victimTeamId).deaths += 1;
      for (const aid of p.assistPlayerIds ?? []) ensurePlayer(s, aid, p.killerTeamId).assists += 1;
      // team kills tracked even when the killer player is unknown.
      s.teamKills[p.killerTeamId] = (s.teamKills[p.killerTeamId] ?? 0) + 1;
      recomputeTeamKills(s);
      break;
    }
    case "NET_WORTH_UPDATE": {
      const p = event.payload as NetWorthPayload;
      s.netWorth[p.teamId] = Math.max(s.netWorth[p.teamId] ?? 0, p.gold);
      break;
    }
    case "TURTLE_KILLED": {
      const p = event.payload as { teamId?: TeamId | null };
      s.objectives.turtleTotal += 1;
      if (p.teamId) bumpObjective(s, p.teamId, "turtle");
      break;
    }
    case "LORD_KILLED": {
      const p = event.payload as { teamId?: TeamId | null };
      s.objectives.lordTotal += 1;
      if (p.teamId) bumpObjective(s, p.teamId, "lord");
      break;
    }
    case "TURRET_DESTROYED": {
      const p = event.payload as TurretPayload;
      const t = (s.turrets[p.teamId] = s.turrets[p.teamId] ?? { destroyed: 0, lanes: {} });
      t.destroyed += 1;
      if (p.lane && p.tier) t.lanes[`${p.lane}-${p.tier}`] = true;
      bumpObjective(s, p.teamId, "tower");
      break;
    }
    case "BASE_DESTROYED": {
      s.status = "finished";
      break;
    }
    case "GAME_FINISHED": {
      s.status = "finished";
      break;
    }
    case "GAME_RESET": {
      // Handled by the engine (archives old game, starts new context). In a
      // single-game reducer replay this is a no-op boundary marker.
      break;
    }
    case "MANUAL_CORRECTION": {
      applyCorrection(s, event.payload as CorrectionPayload);
      break;
    }
  }

  s.stateVersion += 1;
  s.timeline.push(event.eventId);
  s.lastConfirmedAt = event.createdAt;
  return s;
}

function bumpObjective(s: ConfirmedState, teamId: string, type: "turtle" | "lord" | "tower"): void {
  const byTeam = (s.objectives.byTeam[teamId] = s.objectives.byTeam[teamId] ?? { turtle: 0, lord: 0, tower: 0 });
  byTeam[type] += 1;
}

// A manual correction is a first-class audited event (spec §23). It sets an
// absolute value rather than a delta, and can even override the finished lock —
// the only thing allowed to change a finished game (spec §19).
function applyCorrection(s: ConfirmedState, p: CorrectionPayload): void {
  const [kind, ...rest] = p.field.split(":");
  const key = rest.join(":");
  const nv = p.newValue;
  switch (kind) {
    case "timer":
      if (typeof nv === "number") s.timerSeconds = nv;
      break;
    case "team_kills":
      if (typeof nv === "number") s.teamKills[key] = nv;
      break;
    case "net_worth":
      if (typeof nv === "number") s.netWorth[key] = nv;
      break;
    case "player_kills":
    case "player_deaths":
    case "player_assists": {
      const p2 = s.players[key];
      if (p2 && typeof nv === "number") {
        if (kind === "player_kills") p2.kills = nv;
        if (kind === "player_deaths") p2.deaths = nv;
        if (kind === "player_assists") p2.assists = nv;
        recomputeTeamKills(s);
      }
      break;
    }
    case "status":
      if (nv === "not_started" || nv === "in_progress" || nv === "finished") s.status = nv;
      break;
  }
}

// Rebuild confirmed state from scratch by replaying an ordered event list.
export function reduceEvents(gameId: GameId, events: GameEvent[]): ConfirmedState {
  let s = initialState(gameId);
  for (const e of events) {
    if (e.status !== "confirmed") continue; // candidates/rejected never affect confirmed state
    s = applyEvent(s, e);
  }
  return s;
}
