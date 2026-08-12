// Reconstruction engine orchestrator (spec §3 pipeline) — the single entry
// point that turns a tick of observations into confirmed events + confirmed
// state:
//
//   RAW OCR → NORMALIZE → COMPARE → VALIDATE GAME LOGIC → CONFIRM → UPDATE
//
// The engine owns the per-game context (confirmed state + event log + rolling
// evidence) and is fed one "observation tick" at a time. Both the live Hot
// Match capture path (in shadow mode) and the replay harness drive it through
// exactly this function, so tests exercise the real production path.
import type {
  ConfirmedState,
  GameEvent,
  GameId,
  TeamId,
  PlayerId,
  ObservationSource,
  ObservationField,
  ObservationStatus,
} from "./types.ts";
import { createLog, appendEvent, orderedEvents, createEvent } from "./events.ts";
import type { EventLog } from "./events.ts";
import { reduceEvents } from "./reducer.ts";
import { validateTimer } from "./validators/timer.ts";
import { validateNetWorth } from "./validators/netWorth.ts";
import { validateKdaBatch, validateTeamKills } from "./validators/kda.ts";
import type { PlayerKda } from "./validators/kda.ts";
import { validateTurtle, validateLord, validateTurret } from "./validators/objectives.ts";
import { reconstructKills } from "./killEngine.ts";
import type { PlayerDelta } from "./killEngine.ts";
import { detectReset, NO_SIGNALS } from "./reset.ts";
import type { ResetSignals } from "./reset.ts";

// One tick of observations, already normalized upstream (the engine takes typed
// values, never raw strings — normalization is a separate, unit-tested layer).
export type ObservationTick = {
  gameTimeSeconds: number | null;
  timer?: number | null;
  teamKills?: Partial<Record<string, number>>; // teamId → reading
  netWorth?: Partial<Record<string, number>>; // teamId → gold reading
  playerKda?: { playerId: PlayerId; teamId: TeamId; kda: PlayerKda }[];
  objectives?: {
    turtle?: Partial<Record<string, number>>; // teamId → new count
    lord?: Partial<Record<string, number>>;
    tower?: Partial<Record<string, number>>;
  };
  baseDestroyed?: TeamId | null; // team whose base fell
  gameFinished?: boolean; // explicit admin finish
  resetSignals?: Partial<ResetSignals>;
  source?: ObservationSource;
  confidence?: number | null;
  capturedAt?: number;
};

export type FieldDiagnostic = {
  field: ObservationField | string;
  status: ObservationStatus;
  candidateValue?: unknown;
  reason: string;
  confidence: number | null;
  lastObservedAt: number | null;
};

export type Engine = {
  gameId: GameId;
  teamAId: TeamId;
  teamBId: TeamId;
  playerTeam: Map<string, string>; // playerId → teamId
  log: EventLog;
  state: ConfirmedState;
  lastTurtleKillSeconds: number | null;
  lastLordKillSeconds: number | null;
  diagnostics: Map<string, FieldDiagnostic>;
  // seconds of the last confirmed timer (compare basis)
};

export function createEngine(args: { gameId: GameId; teamAId: TeamId; teamBId: TeamId }): Engine {
  return {
    gameId: args.gameId,
    teamAId: args.teamAId,
    teamBId: args.teamBId,
    playerTeam: new Map(),
    log: createLog(args.gameId),
    state: reduceEvents(args.gameId, []),
    lastTurtleKillSeconds: null,
    lastLordKillSeconds: null,
    diagnostics: new Map(),
  };
}

function setDiag(e: Engine, d: FieldDiagnostic): void {
  e.diagnostics.set(d.field, d);
}

function emit(e: Engine, event: GameEvent): void {
  const r = appendEvent(e.log, event);
  if (r.appended) e.state = reduceEvents(e.gameId, orderedEvents(e.log));
}

// Process one observation tick. Returns the events appended this tick (may be
// empty). Rejected/candidate observations never mutate confirmed state.
export function ingest(engine: Engine, tick: ObservationTick): GameEvent[] {
  const source = tick.source ?? "ocr";
  const confidence = tick.confidence ?? null;
  const createdAt = tick.capturedAt ?? Date.now();
  const before = engine.log.events.length;
  const finished = engine.state.status === "finished";

  // ── Reset detection first (spec §18): a confirmed reset archives the old
  // game context. In the single-game engine we surface it as a GAME_RESET
  // boundary event; the caller (multi-game orchestrator / DB layer) is
  // responsible for spinning up a fresh engine for the new game.
  if (tick.resetSignals) {
    const verdict = detectReset({ ...NO_SIGNALS, ...tick.resetSignals });
    if (verdict.isReset) {
      emit(
        engine,
        createEvent({
          gameId: engine.gameId,
          type: "GAME_RESET",
          gameTimeSeconds: tick.gameTimeSeconds,
          payload: {},
          source,
          confidence: verdict.confidence,
          createdAt,
          signature: `reset@${createdAt}`,
        })
      );
      return engine.log.events.slice(before);
    }
  }

  // ── GAME_FINISHED lock (spec §19): once finished, normal telemetry is
  // dropped. Only explicit finish/base/manual correction remain meaningful.
  if (finished && !tick.gameFinished && tick.baseDestroyed == null) {
    setDiag(engine, { field: "game_timer", status: "rejected", reason: "game finished — telemetry frozen", confidence, lastObservedAt: createdAt });
    return [];
  }

  // ── Timer (spec §13) — the primary temporal reference; validate first.
  if (tick.timer !== undefined) {
    const r = validateTimer(tick.timer, { confirmedSeconds: engine.state.timerSeconds || null });
    setDiag(engine, { field: "game_timer", status: r.status, reason: r.reason, candidateValue: tick.timer, confidence, lastObservedAt: createdAt });
    if (r.status === "confirmed" && r.value != null && r.value > engine.state.timerSeconds) {
      emit(engine, createEvent({ gameId: engine.gameId, type: "TIMER_UPDATE", gameTimeSeconds: r.value, payload: { seconds: r.value }, source, confidence, createdAt, signature: `t=${r.value}` }));
    }
  }
  const gameTime = engine.state.timerSeconds || tick.gameTimeSeconds || null;

  // Make sure GAME_STARTED is emitted once telemetry begins.
  if (engine.state.status === "not_started" && (tick.timer != null || tick.playerKda?.length)) {
    emit(engine, createEvent({ gameId: engine.gameId, type: "GAME_STARTED", gameTimeSeconds: gameTime, payload: {}, source, confidence, createdAt, signature: "start" }));
  }

  // ── Player K/D/A batch (spec §4, §14) with kill reconstruction (spec §21).
  if (tick.playerKda && tick.playerKda.length > 0) {
    for (const r of tick.playerKda) engine.playerTeam.set(r.playerId, r.teamId);
    const confirmedMap = new Map<string, PlayerKda>();
    for (const pid of Object.keys(engine.state.players)) {
      const p = engine.state.players[pid];
      confirmedMap.set(pid, { kills: p.kills, deaths: p.deaths, assists: p.assists });
    }
    const batch = validateKdaBatch(
      tick.playerKda.map((r) => ({ playerId: r.playerId, teamId: r.teamId, reading: r.kda })),
      { confirmed: confirmedMap, teamOf: engine.playerTeam, teamAId: engine.teamAId, teamBId: engine.teamBId }
    );
    // Compute per-player deltas from confirmed → new confirmed values.
    const deltas: PlayerDelta[] = [];
    const teamKillDelta: Record<string, number> = {};
    for (const [pid, v] of batch.confirmedValues) {
      const prev = confirmedMap.get(pid) ?? { kills: 0, deaths: 0, assists: 0 };
      const teamId = engine.playerTeam.get(pid) as TeamId;
      const dK = v.kills - prev.kills;
      const dD = v.deaths - prev.deaths;
      const dA = v.assists - prev.assists;
      if (dK || dD || dA) deltas.push({ playerId: pid as PlayerId, teamId, dKills: dK, dDeaths: dD, dAssists: dA });
      if (dK > 0) teamKillDelta[teamId] = (teamKillDelta[teamId] ?? 0) + dK;
      const d = batch.decisions.find((x) => x.playerId === pid)!;
      setDiag(engine, { field: `player_kda:${pid}`, status: d.result.status, reason: d.result.reason, candidateValue: v, confidence, lastObservedAt: createdAt });
    }
    // Emit atomic KILL events (spec §21) — reconciles team + player totals.
    if (Object.keys(teamKillDelta).length > 0) {
      const kills = reconstructKills({ gameId: engine.gameId, gameTimeSeconds: gameTime, teamAId: engine.teamAId, teamBId: engine.teamBId, teamKillDelta, playerDeltas: deltas, source, confidence });
      for (const k of kills) emit(engine, k);
    }
    // Any death-only / assist-only deltas not captured by kills (e.g. deaths
    // to neutral objectives) are applied via a STAT_UPDATE reconciliation.
    for (const [pid, v] of batch.confirmedValues) {
      const teamId = engine.playerTeam.get(pid) as TeamId;
      emit(engine, createEvent({ gameId: engine.gameId, type: "STAT_UPDATE", gameTimeSeconds: gameTime, payload: { teamId, playerId: pid as PlayerId, kills: v.kills, deaths: v.deaths, assists: v.assists }, source, confidence, createdAt, signature: `stat:${pid}:${v.kills}/${v.deaths}/${v.assists}` }));
    }
  }

  // ── Team kills aggregate tracker (spec §4) — CROSS-CHECK ONLY.
  // It does NOT mint kills. The live shadow run (game bca5ba0c) proved why:
  // emitting one orphan KILL per unattributed team-kill increment fabricated
  // 8 kills with null killer AND null victim, inflating Team A's confirmed
  // team kills to 27 while its five players summed to 19 — a permanent
  // "player kills sum to team kills" violation from zero participant evidence,
  // exactly what spec §21 forbids ("do not fabricate killer/assist identity
  // when evidence is insufficient"). Confirmed team kills now derive purely
  // from player-attributed KILL/STAT events (reducer.recomputeTeamKills), so
  // teamKills always equals the summed player kills. A team-kills reading that
  // runs ahead of player attribution is surfaced as a candidate divergence for
  // the admin — never committed as truth.
  if (tick.teamKills) {
    for (const teamId of Object.keys(tick.teamKills)) {
      const reading = tick.teamKills[teamId] ?? null;
      const confirmed = engine.state.teamKills[teamId] ?? null;
      const summed = Object.values(engine.state.players).filter((p) => p.teamId === teamId).reduce((s, p) => s + p.kills, 0);
      const r = validateTeamKills(reading, confirmed, summed);
      // Ahead of attribution → candidate (needs per-player evidence to confirm),
      // otherwise agrees with the reconciled total.
      const aheadOfPlayers = reading != null && reading > summed;
      setDiag(engine, {
        field: `team_kills:${teamId}`,
        status: aheadOfPlayers ? "candidate" : r.status,
        reason: aheadOfPlayers ? `reads ${reading} but only ${summed} kills attributed to players — awaiting per-player evidence` : r.reason,
        candidateValue: reading,
        confidence,
        lastObservedAt: createdAt,
      });
    }
  }

  // ── Net worth (spec §5, §15).
  if (tick.netWorth) {
    for (const teamId of Object.keys(tick.netWorth)) {
      const reading = tick.netWorth[teamId] ?? null;
      const r = validateNetWorth(reading, engine.state.netWorth[teamId] ?? null);
      setDiag(engine, { field: `net_worth:${teamId}`, status: r.status, reason: r.reason, candidateValue: reading, confidence, lastObservedAt: createdAt });
      if (r.status === "confirmed" && r.value != null) {
        emit(engine, createEvent({ gameId: engine.gameId, type: "NET_WORTH_UPDATE", gameTimeSeconds: gameTime, payload: { teamId: teamId as TeamId, gold: r.value }, source, confidence, createdAt, signature: `nw:${teamId}:${r.value}` }));
      }
    }
  }

  // ── Objectives (spec §7, §8, §9) — legal state transitions only.
  if (tick.objectives && gameTime != null) {
    ingestObjectiveType(engine, "turtle", tick.objectives.turtle, gameTime, source, confidence, createdAt);
    ingestObjectiveType(engine, "lord", tick.objectives.lord, gameTime, source, confidence, createdAt);
    ingestObjectiveType(engine, "tower", tick.objectives.tower, gameTime, source, confidence, createdAt);
  }

  // ── Base destroyed → GAME_FINISHED (spec §9, §19).
  if (tick.baseDestroyed != null) {
    emit(engine, createEvent({ gameId: engine.gameId, type: "BASE_DESTROYED", gameTimeSeconds: gameTime, payload: { teamId: tick.baseDestroyed }, source, confidence, createdAt, signature: `base:${tick.baseDestroyed}` }));
  }
  if (tick.gameFinished) {
    emit(engine, createEvent({ gameId: engine.gameId, type: "GAME_FINISHED", gameTimeSeconds: gameTime, payload: {}, source, confidence, createdAt, signature: "finish" }));
  }

  return engine.log.events.slice(before);
}

function ingestObjectiveType(
  engine: Engine,
  type: "turtle" | "lord" | "tower",
  readings: Partial<Record<string, number>> | undefined,
  gameTime: number,
  source: ObservationSource,
  confidence: number | null,
  createdAt: number
): void {
  if (!readings) return;
  for (const teamId of Object.keys(readings)) {
    const target = readings[teamId] ?? 0;
    const current = engine.state.objectives.byTeam[teamId]?.[type] ?? 0;
    let ok = false;
    let reason = "";
    if (type === "turtle") {
      const r = validateTurtle(target, current, { timerSeconds: gameTime, turtleTotal: engine.state.objectives.turtleTotal, lastTurtleKillSeconds: engine.lastTurtleKillSeconds });
      ok = r.status === "confirmed" && (r.value ?? current) > current;
      reason = r.reason;
    } else if (type === "lord") {
      const r = validateLord(target, current, { timerSeconds: gameTime, lastLordKillSeconds: engine.lastLordKillSeconds });
      ok = r.status === "confirmed" && (r.value ?? current) > current;
      reason = r.reason;
    } else {
      const r = validateTurret(target, current);
      ok = (r.status === "confirmed" || r.status === "candidate") && (r.value ?? current) > current;
      reason = r.reason;
    }
    setDiag(engine, { field: `objective_${type}:${teamId}`, status: ok ? "confirmed" : "rejected", reason, candidateValue: target, confidence, lastObservedAt: createdAt });
    if (!ok) continue;
    const advanceTo = type === "tower" ? Math.min(target, current + 3) : current + 1;
    for (let c = current; c < advanceTo; c++) {
      const evType = type === "turtle" ? "TURTLE_KILLED" : type === "lord" ? "LORD_KILLED" : "TURRET_DESTROYED";
      emit(engine, createEvent({ gameId: engine.gameId, type: evType, gameTimeSeconds: gameTime, payload: { teamId: teamId as TeamId }, source, confidence, createdAt, signature: `${type}:${teamId}:${c}` }));
      if (type === "turtle") engine.lastTurtleKillSeconds = gameTime;
      if (type === "lord") engine.lastLordKillSeconds = gameTime;
    }
  }
}
