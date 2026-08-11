// Replay harness (spec §32) — feed a sequence of observation ticks through the
// REAL production pipeline (the engine) and compare reconstructed events/state
// against expected ground truth. The harness never bypasses validation; it is
// the same ingest() the live path uses.
import type { GameEvent, ConfirmedState, GameId, TeamId } from "./types.ts";
import { createEngine, ingest } from "./engine.ts";
import type { ObservationTick, Engine } from "./engine.ts";
import { reconcile } from "./reconcile.ts";

export type ReplayScenario = {
  name: string;
  gameId: GameId;
  teamAId: TeamId;
  teamBId: TeamId;
  ticks: ObservationTick[];
};

export type ReplayResult = {
  name: string;
  engine: Engine;
  events: GameEvent[];
  state: ConfirmedState;
  reconciliation: ReturnType<typeof reconcile>;
};

export function runReplay(scenario: ReplayScenario): ReplayResult {
  const engine = createEngine({ gameId: scenario.gameId, teamAId: scenario.teamAId, teamBId: scenario.teamBId });
  const events: GameEvent[] = [];
  for (const tick of scenario.ticks) {
    events.push(...ingest(engine, tick));
  }
  return {
    name: scenario.name,
    engine,
    events,
    state: engine.state,
    reconciliation: reconcile(engine.state),
  };
}

// Convenience assertions used by replay tests.
export function countEvents(result: ReplayResult, type: GameEvent["type"]): number {
  return result.events.filter((e) => e.type === type).length;
}
