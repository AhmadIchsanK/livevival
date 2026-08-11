// Admin State Health (spec §24) — a per-field diagnostic view so an operator can
// see confirmed vs candidate values, confidence, last update, rejection reasons
// and stale/missing trackers WITHOUT reading source code.
import type { ConfirmedState, ObservationField, ObservationStatus } from "./types.ts";

export type FieldHealth = {
  field: string;
  status: ObservationStatus;
  confirmedValue: unknown;
  candidateValue: unknown;
  confidence: number | null;
  lastConfirmedAt: number | null;
  lastObservedAt: number | null;
  rejectionReason: string | null;
  staleMs: number | null; // how long since a good reading, if stale
};

export type FieldObservationMeta = {
  field: ObservationField | string;
  status: ObservationStatus;
  candidateValue?: unknown;
  confidence?: number | null;
  lastObservedAt?: number | null;
  rejectionReason?: string | null;
};

export type StateHealth = {
  gameId: string;
  gameStatus: ConfirmedState["status"];
  stateVersion: number;
  timerSeconds: number;
  fields: FieldHealth[];
  conflicts: string[];
  generatedAt: number;
};

export const STALE_THRESHOLD_MS = 20_000; // ~4 missed 5s ticks

// Build the health view by combining confirmed state with the latest
// observation metadata per field (candidate/rejected/missing lifecycle).
export function buildStateHealth(args: {
  state: ConfirmedState;
  observations: FieldObservationMeta[];
  conflicts: string[];
  now?: number;
}): StateHealth {
  const now = args.now ?? Date.now();
  const metaByField = new Map(args.observations.map((o) => [o.field, o]));

  const confirmedFor = (field: string): unknown => {
    const s = args.state;
    switch (field) {
      case "game_timer":
        return s.timerSeconds;
      case "team_kills":
        return s.teamKills;
      case "net_worth":
        return s.netWorth;
      case "objective_turtle":
        return s.objectives.turtleTotal;
      case "objective_lord":
        return s.objectives.lordTotal;
      case "objective_tower":
        return Object.fromEntries(Object.entries(s.turrets).map(([t, v]) => [t, v.destroyed]));
      default:
        return null;
    }
  };

  const fieldNames = [
    "game_timer",
    "team_kills",
    "net_worth",
    "objective_turtle",
    "objective_lord",
    "objective_tower",
  ];

  const fields: FieldHealth[] = fieldNames.map((field) => {
    const meta = metaByField.get(field);
    const lastObservedAt = meta?.lastObservedAt ?? null;
    const staleMs =
      lastObservedAt != null && now - lastObservedAt > STALE_THRESHOLD_MS ? now - lastObservedAt : null;
    return {
      field,
      status: meta?.status ?? "missing",
      confirmedValue: confirmedFor(field),
      candidateValue: meta?.candidateValue ?? null,
      confidence: meta?.confidence ?? null,
      lastConfirmedAt: args.state.lastConfirmedAt,
      lastObservedAt,
      rejectionReason: meta?.rejectionReason ?? null,
      staleMs,
    };
  });

  return {
    gameId: args.state.gameId,
    gameStatus: args.state.status,
    stateVersion: args.state.stateVersion,
    timerSeconds: args.state.timerSeconds,
    fields,
    conflicts: args.conflicts,
    generatedAt: now,
  };
}
