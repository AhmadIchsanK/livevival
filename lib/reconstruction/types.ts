// LIVEVIVAL — Game-State Reconstruction Engine — domain types
// ===========================================================================
// Target architecture (see docs/RECONSTRUCTION_ENGINE.md):
//
//   STREAM → OBSERVATIONS → NORMALIZATION → VALIDATION → CONFIRMED EVENTS
//          → STATE REDUCER → CONFIRMED SNAPSHOT → PUBLIC API → PUBLIC PAGE
//
// Absolute rule: OCR/vision observations are NOT truth. Only confirmed events
// and the state derived from them are truth. A single bad OCR frame must never
// become incorrect confirmed state.
//
// Every type here is written in erasable TypeScript (no enums, no parameter
// properties) so the whole engine — and its colocated *.test.ts files — run
// directly under `node --experimental-strip-types --test` with zero extra
// dependencies. See package.json "test" script.
// ===========================================================================

// ── Identifiers ────────────────────────────────────────────────────────────
// Branded so a match_id can never be passed where a game_id is expected. The
// brand is a compile-time-only phantom; at runtime these are plain strings.
export type MatchId = string & { readonly __brand: "MatchId" };
export type GameId = string & { readonly __brand: "GameId" };
export type TeamId = string & { readonly __brand: "TeamId" };
export type PlayerId = string & { readonly __brand: "PlayerId" };

export const asMatchId = (s: string): MatchId => s as MatchId;
export const asGameId = (s: string): GameId => s as GameId;
export const asTeamId = (s: string): TeamId => s as TeamId;
export const asPlayerId = (s: string): PlayerId => s as PlayerId;

// ── Sides ──────────────────────────────────────────────────────────────────
// The broadcast's physical left/right, mapped to team_a/team_b by the existing
// Hot Match side-mapping. The engine reasons in terms of teams once mapped.
export type Side = "left" | "right";

// ── Field identity ─────────────────────────────────────────────────────────
export type ObservationField =
  | "game_timer"
  | "team_kills"
  | "net_worth"
  | "player_kda"
  | "objective_turtle"
  | "objective_lord"
  | "objective_tower"
  | "base_crystal"
  | "kill_banner"
  | "draft_phase";

export type ObservationSource = "ocr" | "vision" | "admin" | "replay";

// ── Observation lifecycle (spec §12) ───────────────────────────────────────
export type ObservationStatus = "confirmed" | "candidate" | "rejected" | "missing";

// A raw evidence record, persisted append-only and independent from confirmed
// state (spec §08). raw_value is preserved verbatim for audit; normalized_value
// is the typed interpretation (may be null when normalization rejects it).
export type Observation = {
  observationId: string;
  gameId: GameId;
  field: ObservationField;
  // Which side/team/player this observation is about, when applicable.
  side?: Side;
  teamId?: TeamId;
  playerId?: PlayerId;
  // Game clock (seconds) this observation was captured at, when known. The
  // timer is the primary temporal reference (spec §13), so most reasoning is
  // anchored to it rather than wall-clock.
  gameTimeSeconds: number | null;
  capturedAt: number; // wall-clock ms, for ordering/staleness only
  rawValue: string;
  normalizedValue: NormalizedValue | null;
  confidence: number | null; // 0..1 (or 0..100 from Tesseract, normalized to 0..1)
  source: ObservationSource;
};

// ── Normalized values (spec §11) ───────────────────────────────────────────
// The typed output of normalization. No downstream validator ever parses an
// OCR string again — it only ever sees one of these shapes.
export type KdaValue = { kind: "kda"; kills: number; deaths: number; assists: number };
export type TimerValue = { kind: "timer"; seconds: number }; // MM:SS → seconds
export type NetWorthValue = { kind: "net_worth"; gold: number }; // full integer, e.g. 5500
export type CountValue = { kind: "count"; count: number }; // team kills, objective counts
export type BannerValue = { kind: "banner"; text: string }; // kill-banner / semantic

export type NormalizedValue = KdaValue | TimerValue | NetWorthValue | CountValue | BannerValue;

// ── Confirmed events (spec §09) ────────────────────────────────────────────
export type GameStatus = "not_started" | "in_progress" | "finished";

export type EventType =
  | "GAME_STARTED"
  | "KILL"
  | "STAT_UPDATE"
  | "NET_WORTH_UPDATE"
  | "TIMER_UPDATE"
  | "TURTLE_SPAWNED"
  | "TURTLE_KILLED"
  | "LORD_SPAWNED"
  | "LORD_KILLED"
  | "TURRET_DESTROYED"
  | "BASE_DESTROYED"
  | "GAME_FINISHED"
  | "GAME_RESET"
  | "MANUAL_CORRECTION";

export type EventStatus = "candidate" | "confirmed" | "rejected";

// Payload shapes per event type. Kept small and explicit — important history is
// never encoded only as counters (spec §09 guardrail).
export type KillPayload = {
  killerTeamId: TeamId;
  victimTeamId: TeamId;
  killerPlayerId?: PlayerId | null;
  victimPlayerId?: PlayerId | null;
  assistPlayerIds?: PlayerId[];
};
export type StatPayload = {
  teamId: TeamId;
  playerId: PlayerId;
  kills: number;
  deaths: number;
  assists: number;
  heroName?: string | null;
};
export type NetWorthPayload = { teamId: TeamId; gold: number };
export type TimerPayload = { seconds: number };
export type ObjectivePayload = { teamId?: TeamId | null };
export type TurretPayload = { teamId: TeamId; lane?: "top" | "mid" | "bot"; tier?: 1 | 2 | 3 };
export type CorrectionPayload = {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  admin: string;
  reason: string;
};

export type EventPayload =
  | KillPayload
  | StatPayload
  | NetWorthPayload
  | TimerPayload
  | ObjectivePayload
  | TurretPayload
  | CorrectionPayload
  | Record<string, never>;

export type GameEvent = {
  eventId: string; // stable/idempotent — duplicate delivery is a no-op
  gameId: GameId;
  type: EventType;
  gameTimeSeconds: number | null;
  createdAt: number;
  payload: EventPayload;
  source: ObservationSource;
  confidence: number | null;
  status: EventStatus;
  // observationIds this event was reconstructed from (spec §08 traceability).
  evidence: string[];
  // Monotonic per-game sequence assigned when the event is appended to the log.
  seq?: number;
};

// ── Derived / confirmed state (spec §10) ───────────────────────────────────
export type PlayerState = {
  playerId: PlayerId;
  teamId: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  heroName: string | null;
};

export type ObjectiveCounts = { turtle: number; lord: number; tower: number };

export type TurretState = {
  // Per-team destroyed turret count (monotonic). Physical lane/tier map is
  // optional and only filled when evidence identifies the exact turret.
  destroyed: number;
  lanes: Record<string, boolean>; // e.g. "top-1": true
};

export type ConfirmedState = {
  gameId: GameId;
  status: GameStatus;
  timerSeconds: number;
  teamKills: Record<string, number>; // teamId → kills
  netWorth: Record<string, number>; // teamId → full integer gold
  players: Record<string, PlayerState>; // playerId → state
  objectives: {
    // per team, plus derived totals used by turtle/lord global caps
    byTeam: Record<string, ObjectiveCounts>;
    turtleTotal: number;
    lordTotal: number;
  };
  turrets: Record<string, TurretState>; // teamId → turret state
  // Monotonic version bumped on every confirmed mutation — public clients use
  // it to detect missed updates on reconnect (spec §27/§37).
  stateVersion: number;
  // Chronological confirmed-event ids, for timeline rendering.
  timeline: string[];
  lastConfirmedAt: number | null;
};

// ── Validation result ──────────────────────────────────────────────────────
// The uniform output of every validator: whether the observation becomes a
// confirmed value, a held candidate, or is rejected — plus a human reason that
// surfaces in admin diagnostics (spec §24).
export type ValidationResult<T> = {
  status: ObservationStatus;
  value: T | null; // the value to apply/confirm (may be a clamped-down value)
  reason: string;
};

export const ok = <T>(value: T, reason = "ok"): ValidationResult<T> => ({
  status: "confirmed",
  value,
  reason,
});
export const candidate = <T>(value: T | null, reason: string): ValidationResult<T> => ({
  status: "candidate",
  value,
  reason,
});
export const reject = <T>(reason: string): ValidationResult<T> => ({
  status: "rejected",
  value: null,
  reason,
});
export const missing = <T>(reason = "no reading"): ValidationResult<T> => ({
  status: "missing",
  value: null,
  reason,
});
