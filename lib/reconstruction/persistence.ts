// Reconstruction persistence (spec Phase 1) — pure builders that turn engine
// output into the exact row shapes for game_observations / game_events /
// confirmed_game_state, plus the idempotency contract. No I/O here: the server
// ingest route (app/api/admin/reconstruction/ingest) performs the actual
// service-role upserts using these shapes, so the mapping stays unit-testable.
//
// Idempotency (verified against the live schema):
//   - game_events: upsert ON CONFLICT (game_id, event_id) DO NOTHING — a
//     re-delivered event (same deterministic event_id) is a no-op, so a
//     duplicate OCR frame never double-counts.
//   - confirmed_game_state: upsert ON CONFLICT (game_id) DO UPDATE — one row
//     per game; state_version only ever advances.
//   - game_observations: append-only evidence; a client-supplied stable id
//     dedups a retried tick.
import type { GameEvent, ConfirmedState } from "./types.ts";
import type { PublicGameState } from "./snapshot.ts";
import { toPublicState } from "./snapshot.ts";

export type EventRow = {
  event_id: string;
  game_id: string;
  match_id: string | null;
  seq: number | null;
  type: string;
  game_time_seconds: number | null;
  payload: unknown;
  source: string;
  confidence: number | null;
  status: string;
  evidence: string[];
};

export function eventRows(events: GameEvent[], matchId: string | null): EventRow[] {
  return events.map((e) => ({
    event_id: e.eventId,
    game_id: e.gameId,
    match_id: matchId,
    seq: e.seq ?? null,
    type: e.type,
    game_time_seconds: e.gameTimeSeconds,
    payload: e.payload,
    source: e.source,
    confidence: e.confidence,
    status: e.status,
    evidence: e.evidence,
  }));
}

export type SnapshotRow = {
  game_id: string;
  match_id: string | null;
  status: string;
  state_version: number;
  timer_seconds: number;
  state: PublicGameState;
};

export function snapshotRow(state: ConfirmedState, matchId: string | null): SnapshotRow {
  const pub = toPublicState(state);
  return {
    game_id: state.gameId,
    match_id: matchId,
    status: state.status,
    state_version: state.stateVersion,
    timer_seconds: state.timerSeconds,
    state: pub,
  };
}

export type ObservationRow = {
  id: string;
  game_id: string;
  match_id: string | null;
  field: string;
  team_id: string | null;
  player_id: string | null;
  game_time_seconds: number | null;
  raw_value: string;
  normalized_value: unknown;
  confidence: number | null;
  source: string;
  status: string;
};

// A stable observation id from its identity fields, so a retried tick writing
// the same reading doesn't create a duplicate evidence row.
export function observationId(gameId: string, field: string, gameTime: number | null, raw: string): string {
  const basis = `${gameId}|${field}|${gameTime ?? "?"}|${raw}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `obs_${h.toString(36)}`;
}

// The payload the client posts to the ingest route after a shadow tick. Small
// and idempotent: the newly-appended confirmed events + the current snapshot.
export type IngestPayload = {
  gameId: string;
  matchId: string | null;
  events: EventRow[];
  snapshot: SnapshotRow;
};

export function buildIngestPayload(args: {
  state: ConfirmedState;
  newEvents: GameEvent[];
  matchId: string | null;
}): IngestPayload {
  return {
    gameId: args.state.gameId,
    matchId: args.matchId,
    events: eventRows(
      args.newEvents.filter((e) => e.status === "confirmed"),
      args.matchId
    ),
    snapshot: snapshotRow(args.state, args.matchId),
  };
}
