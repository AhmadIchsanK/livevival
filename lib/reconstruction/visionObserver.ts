// LIVEVIVAL — AI Vision as a non-authoritative observer (spec §25-27)
// ===========================================================================
// The spec is emphatic (slides 4, 25, 26, 44): AI Vision is a FALLBACK
// OBSERVER, never authority. Its output must flow through the SAME validators
// as local CV/OCR, becoming graded observations — a malformed or contradictory
// AI read becomes a candidate/rejection, and AI failure leaves confirmed state
// unchanged.
//
// This module is the pure transform that turns one AI frame-detection into that
// graded observation set. It performs NO I/O and mutates nothing: it runs the
// canonical net-worth + KDA validators over the AI reading against the current
// confirmed values, and attaches the spec-§30 evidence band. The caller decides
// what to do with the result (today: record it append-only in game_observations
// for the fusion phase to reconcile; never a direct confirmed-state write).
// ===========================================================================

import type { ObservationField, ObservationStatus, PlayerId, TeamId, NormalizedValue } from "./types.ts";
import { validateNetWorth } from "./validators/netWorth.ts";
import { validateKdaBatch } from "./validators/kda.ts";
import type { PlayerKda } from "./validators/kda.ts";
import { gradeEvidence } from "./confidence.ts";
import type { EvidenceBand } from "./confidence.ts";

export type VisionPlayerStat = {
  playerId: PlayerId;
  teamId: TeamId;
  kills: number;
  deaths: number;
  assists: number;
};

export type VisionDetection = {
  players?: VisionPlayerStat[];
  netWorth?: Partial<Record<string, number>>; // teamId → gold reading
};

export type VisionConfirmedContext = {
  confirmedKda: Map<string, PlayerKda>; // playerId → last confirmed KDA
  confirmedNetWorth: Record<string, number | null>; // teamId → confirmed gold
  teamOf: Map<string, string>; // playerId → teamId
  teamAId: TeamId;
  teamBId: TeamId;
};

export type VisionObservation = {
  field: ObservationField;
  teamId?: string;
  playerId?: string;
  rawValue: string;
  normalizedValue: NormalizedValue | null;
  status: ObservationStatus;
  reason: string;
  band: EvidenceBand;
  score: number;
};

function grade(status: ObservationStatus, rawConfidence: number | null, repetition: number) {
  return gradeEvidence({
    source: "vision",
    rawConfidence,
    repetition,
    // The validator's own verdict is the temporal-consistency signal: a
    // confirmed reading agrees with the last confirmed value, a rejected one
    // contradicts it, candidate/missing is inconclusive.
    temporallyConsistent: status === "confirmed" ? true : status === "rejected" ? false : null,
    crossFieldConsistent: null,
  });
}

// Turn one AI detection into graded observations. `opts.rawConfidence` is the
// model's own 0..1 confidence for the frame; `opts.repetition` lets a caller
// that tracks repeated identical AI reads raise the band (defaults to 1 — a
// single fresh read, i.e. MEDIUM at best per §30).
export function observeVision(
  det: VisionDetection,
  ctx: VisionConfirmedContext,
  opts?: { rawConfidence?: number | null; repetition?: number }
): VisionObservation[] {
  const rawConfidence = opts?.rawConfidence ?? null;
  const repetition = opts?.repetition ?? 1;
  const out: VisionObservation[] = [];

  // ── Net worth per team ──────────────────────────────────────────────────
  if (det.netWorth) {
    for (const teamId of Object.keys(det.netWorth)) {
      const reading = det.netWorth[teamId] ?? null;
      const r = validateNetWorth(reading, ctx.confirmedNetWorth[teamId] ?? null);
      const g = grade(r.status, rawConfidence, repetition);
      out.push({
        field: "net_worth",
        teamId,
        rawValue: reading == null ? "" : String(reading),
        normalizedValue: reading == null ? null : { kind: "net_worth", gold: reading },
        status: r.status,
        reason: r.reason,
        band: g.band,
        score: g.score,
      });
    }
  }

  // ── Player KDA, validated as one batch so cross-player rules apply ───────
  if (det.players && det.players.length > 0) {
    const batch = validateKdaBatch(
      det.players.map((p) => ({ playerId: p.playerId, teamId: p.teamId, reading: { kills: p.kills, deaths: p.deaths, assists: p.assists } })),
      { confirmed: ctx.confirmedKda, teamOf: ctx.teamOf, teamAId: ctx.teamAId, teamBId: ctx.teamBId }
    );
    for (const p of det.players) {
      const d = batch.decisions.find((x) => x.playerId === p.playerId);
      if (!d) continue;
      const g = grade(d.result.status, rawConfidence, repetition);
      out.push({
        field: "player_kda",
        playerId: p.playerId,
        teamId: p.teamId,
        rawValue: `${p.kills}/${p.deaths}/${p.assists}`,
        normalizedValue: d.result.value ? { kind: "kda", kills: d.result.value.kills, deaths: d.result.value.deaths, assists: d.result.value.assists } : null,
        status: d.result.status,
        reason: d.result.reason,
        band: g.band,
        score: g.score,
      });
    }
  }

  return out;
}
