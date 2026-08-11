// Confirmed event system (spec §09, §21, §37) — events are first-class,
// replayable, and idempotent. Duplicate delivery of the same input never
// changes final state twice.
// ---------------------------------------------------------------------------
import type {
  GameEvent,
  GameId,
  EventType,
  EventPayload,
  ObservationSource,
} from "./types.ts";

// A stable, deterministic event id derived from its identity-bearing fields.
// Two events describing the same thing (same game, type, game-time bucket, and
// payload signature) produce the same id, so a duplicate OCR frame that would
// re-emit "KILL at 04:12, killer a1, victim b3" collapses to one event. Uses a
// small non-cryptographic hash — ids only need to be stable and collision-rare
// within a single game, not secure.
export function makeEventId(
  gameId: GameId,
  type: EventType,
  gameTimeSeconds: number | null,
  signature: string
): string {
  const basis = `${gameId}|${type}|${gameTimeSeconds ?? "?"}|${signature}`;
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${type.toLowerCase()}_${h.toString(36)}`;
}

// Signature builders per event type — the identity of an event for dedup.
export function killSignature(p: {
  killerPlayerId?: string | null;
  victimPlayerId?: string | null;
  killerTeamId: string;
  victimTeamId: string;
}): string {
  return `${p.killerTeamId}>${p.victimTeamId}|${p.killerPlayerId ?? "?"}>${p.victimPlayerId ?? "?"}`;
}

export function createEvent(args: {
  gameId: GameId;
  type: EventType;
  gameTimeSeconds: number | null;
  payload: EventPayload;
  source: ObservationSource;
  confidence: number | null;
  evidence?: string[];
  signature?: string;
  createdAt?: number;
  status?: GameEvent["status"];
}): GameEvent {
  const signature = args.signature ?? JSON.stringify(args.payload);
  return {
    eventId: makeEventId(args.gameId, args.type, args.gameTimeSeconds, signature),
    gameId: args.gameId,
    type: args.type,
    gameTimeSeconds: args.gameTimeSeconds,
    createdAt: args.createdAt ?? Date.now(),
    payload: args.payload,
    source: args.source,
    confidence: args.confidence,
    status: args.status ?? "confirmed",
    evidence: args.evidence ?? [],
  };
}

// An append-only per-game event log with idempotent append and monotonic
// sequence numbers (spec §37). Appending an event whose id already exists is a
// no-op that returns the existing log unchanged — this is the concrete
// mechanism behind "duplicate OCR frames must not create duplicate kills".
export type EventLog = {
  gameId: GameId;
  events: GameEvent[];
  seenIds: Set<string>;
  nextSeq: number;
};

export function createLog(gameId: GameId): EventLog {
  return { gameId, events: [], seenIds: new Set(), nextSeq: 1 };
}

export function appendEvent(log: EventLog, event: GameEvent): { log: EventLog; appended: boolean } {
  if (log.seenIds.has(event.eventId)) return { log, appended: false };
  const seq = log.nextSeq;
  const stored: GameEvent = { ...event, seq };
  log.events.push(stored);
  log.seenIds.add(event.eventId);
  log.nextSeq = seq + 1;
  return { log, appended: true };
}

// Events in chronological order: primarily by game time (the authoritative
// temporal reference, spec §13), falling back to append sequence when game time
// is equal or unknown.
export function orderedEvents(log: EventLog): GameEvent[] {
  return [...log.events].sort((a, b) => {
    const at = a.gameTimeSeconds ?? Number.POSITIVE_INFINITY;
    const bt = b.gameTimeSeconds ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}
