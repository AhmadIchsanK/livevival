// Live shadow adapter (spec Phase 2) — runs the reconstruction engine ALONGSIDE
// the legacy Hot Match capture path, in the admin browser, off the same real
// OCR reads. It never controls public state and, by construction, can never
// break capture: every entry point is wrapped so a thrown error is swallowed
// and capture continues.
//
// The legacy path keeps writing the DB exactly as before. This adapter only:
//   1. feeds the same real observations into engine.ingest()
//   2. compares the reconstructed confirmed state to the legacy values
//   3. returns categorized divergences for an admin diagnostic panel
import type { Engine } from "./engine.ts";
import { createEngine, ingest } from "./engine.ts";
import type { ObservationTick } from "./engine.ts";
import type { GameId, TeamId, PlayerId } from "./types.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";
import type { LegacyState } from "./snapshot.ts";
import { shadowCompare } from "./snapshot.ts";
import type { Divergence, DivergenceCategory } from "./shadow.ts";

// Raw per-tick reads accumulated by the capture loop (pre-legacy-guard values,
// so the engine does its own independent validation).
export type ShadowTickReads = {
  timerSeconds: number | null;
  teamKills: Record<string, number>; // teamId → raw reading
  netWorth: Record<string, number>; // teamId → raw gold
  playerKda: { playerId: string; teamId: string; kills: number; deaths: number; assists: number }[];
  objectives: {
    turtle: Record<string, number>; // teamId → raw target count
    lord: Record<string, number>;
    tower: Record<string, number>;
  };
};

export function emptyShadowReads(): ShadowTickReads {
  return { timerSeconds: null, teamKills: {}, netWorth: {}, playerKda: [], objectives: { turtle: {}, lord: {}, tower: {} } };
}

// A mutable holder the component keeps in a ref across ticks.
export type ShadowSession = {
  gameId: string;
  engine: Engine;
  divergences: Divergence[];
  lastComparedAt: number | null;
};

export function ensureSession(
  current: ShadowSession | null,
  gameId: string,
  teamAId: string,
  teamBId: string
): ShadowSession {
  if (current && current.gameId === gameId) return current;
  return {
    gameId,
    engine: createEngine({ gameId: asGameId(gameId), teamAId: asTeamId(teamAId), teamBId: asTeamId(teamBId) }),
    divergences: [],
    lastComparedAt: null,
  };
}

function toTick(reads: ShadowTickReads): ObservationTick {
  return {
    gameTimeSeconds: reads.timerSeconds,
    timer: reads.timerSeconds,
    teamKills: reads.teamKills,
    netWorth: reads.netWorth,
    playerKda: reads.playerKda.map((p) => ({
      playerId: asPlayerId(p.playerId) as PlayerId,
      teamId: asTeamId(p.teamId) as TeamId,
      kda: { kills: p.kills, deaths: p.deaths, assists: p.assists },
    })),
    objectives: reads.objectives,
    source: "ocr",
  };
}

// Categorize a raw shadowCompare divergence using the engine diagnostics.
function categorize(field: string, legacy: unknown, reconstructed: unknown): DivergenceCategory {
  // Legacy value present but reconstruction lower/absent → the engine held a
  // suspicious reading the legacy path committed. Most net-worth/team-kill
  // divergences are of this kind; that is exactly the corruption class the
  // engine exists to reject, so default to LEGACY_WRONG and let a human
  // reclassify from the panel.
  if (typeof legacy === "number" && typeof reconstructed === "number") {
    if (reconstructed < legacy) return "LEGACY_WRONG";
    if (reconstructed > legacy) return "TIMING_ALIGNMENT"; // engine ahead — usually lag
  }
  if (reconstructed == null) return "MISSING_OBSERVATION";
  return "EXPECTED_DIFFERENCE";
}

// Run one shadow tick. NEVER throws. Returns the updated session (same object,
// mutated) or the input session unchanged on any error.
export function runShadowTick(
  session: ShadowSession,
  reads: ShadowTickReads,
  legacy: LegacyState
): ShadowSession {
  try {
    ingest(session.engine, toTick(reads));
    const raw = shadowCompare(legacy, session.engine.state);
    session.divergences = raw.map((d) => ({
      field: d.field,
      gameTimeSeconds: session.engine.state.timerSeconds || null,
      legacy: d.legacy,
      reconstructed: d.reconstructed,
      category: categorize(d.field, d.legacy, d.reconstructed),
      reason: `legacy=${JSON.stringify(d.legacy)} reconstructed=${JSON.stringify(d.reconstructed)}`,
    }));
    session.lastComparedAt = Date.now();
  } catch (err) {
    // Shadow mode must never break capture (spec Phase 2 requirement).
    if (typeof console !== "undefined") console.warn("[shadow] tick error (ignored):", err);
  }
  return session;
}
