// LIVEVIVAL — Confidence / evidence model (spec §30)
// ===========================================================================
// Slide 30 defines an evidence grading that sits ON TOP of the existing
// confirmed/candidate/rejected validation status — it does not replace it and
// it never, on its own, mutates confirmed state. Its job is purely to grade
// "how much do we trust this reading right now", so the admin diagnostics
// (spec §41) and the later hybrid CV+AI fusion (spec §28/§29) have a single,
// principled score to reason about instead of a raw recognizer number.
//
//   Bands   — HIGH (repeated valid) · MEDIUM (valid single) · LOW (weak)
//             · UNKNOWN (no evidence).
//   Score   — source reliability + temporal consistency + cross-field
//             consistency + repetition, combined into 0..1.
//   Rule    — candidate values stay separate from confirmed values; a band is
//             advisory metadata, never authority.
//
// Pure and dependency-free so it runs under `node --experimental-strip-types
// --test` like the rest of the engine.
// ===========================================================================

import type { ObservationSource } from "./types.ts";

export type EvidenceBand = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

// Base trust per source, reflecting the spec's roadmap ordering (§5, §29):
// local CV/OCR is the primary deterministic reader; AI vision is a fallback
// observer; admin input is authoritative; replay frames are stale HUD and must
// never be trusted as live telemetry (§20).
export function sourceReliability(source: ObservationSource): number {
  switch (source) {
    case "admin":
      return 1.0;
    case "ocr":
      return 0.8;
    case "vision":
      return 0.65;
    case "replay":
      return 0.25;
    default:
      return 0.5;
  }
}

export type EvidenceSignals = {
  source: ObservationSource;
  // Raw recognizer confidence in 0..1 (Tesseract/AI). null = unknown.
  rawConfidence: number | null;
  // How many consecutive observations have carried this same value. 0 = no
  // evidence yet, 1 = a single fresh valid read, >=2 = repeated agreement.
  repetition: number;
  // Agreement with the temporal expectation (monotonic/plausible vs the last
  // confirmed value). true = consistent, false = contradicted, null = unknown.
  temporallyConsistent: boolean | null;
  // Agreement across fields (e.g. teamKills == Σ player kills). true/false, or
  // null when the check does not apply to this field.
  crossFieldConsistent: boolean | null;
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// Weighted 0..1 evidence score. Weights sum to 1. Repetition saturates at 3 —
// a value confirmed three ticks running is as "repeated" as we need; more does
// not keep inflating the score.
export function scoreEvidence(s: EvidenceSignals): number {
  const rel = sourceReliability(s.source);
  const temporal = s.temporallyConsistent === true ? 1 : s.temporallyConsistent === false ? 0 : 0.5;
  const crossField = s.crossFieldConsistent === true ? 1 : s.crossFieldConsistent === false ? 0 : 0.5;
  const repetition = clamp01(Math.min(Math.max(s.repetition, 0), 3) / 3);
  const raw = s.rawConfidence == null ? 0.5 : clamp01(s.rawConfidence);
  return clamp01(0.28 * rel + 0.24 * temporal + 0.14 * crossField + 0.16 * repetition + 0.18 * raw);
}

// Maps signals to a band. The qualitative slide-30 rules take precedence over
// the raw score so the wording holds exactly: no evidence → UNKNOWN; a
// contradicted reading is always weak (LOW) regardless of how reliable the
// source is; repeated agreement is HIGH; a single valid read is MEDIUM.
export function bandFromSignals(s: EvidenceSignals): EvidenceBand {
  // No reading at all this cycle — nothing to grade.
  if (s.repetition <= 0) return "UNKNOWN";
  // Contradicted by temporal or cross-field logic → weak, never promote.
  if (s.temporallyConsistent === false || s.crossFieldConsistent === false) return "LOW";
  const score = scoreEvidence(s);
  if (s.repetition >= 2 && score >= 0.55) return "HIGH";
  if (s.repetition >= 1 && score >= 0.4) return "MEDIUM";
  return "LOW";
}

export type EvidenceGrade = { band: EvidenceBand; score: number };

export function gradeEvidence(s: EvidenceSignals): EvidenceGrade {
  return { band: bandFromSignals(s), score: scoreEvidence(s) };
}

// ── Repetition tracking ────────────────────────────────────────────────────
// A tiny per-field helper the engine uses to turn a stream of per-tick readings
// into a repetition count without the caller having to remember prior values.
// A stable string key is derived from the reading; equal consecutive keys count
// as repetition, a change resets to 1, and no reading (null key) resets to 0.
export type RepetitionTracker = Map<string, { key: string; repeats: number }>;

export function stableKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

export function trackRepetition(tracker: RepetitionTracker, field: string, value: unknown): number {
  const key = stableKey(value);
  if (key == null) {
    tracker.set(field, { key: "", repeats: 0 });
    return 0;
  }
  const prev = tracker.get(field);
  const repeats = prev && prev.key === key ? prev.repeats + 1 : 1;
  tracker.set(field, { key, repeats });
  return repeats;
}
