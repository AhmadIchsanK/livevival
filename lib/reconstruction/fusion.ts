// LIVEVIVAL — Hybrid CV + AI evidence fusion (spec §28-29)
// ===========================================================================
// Solution 3. CV runs continuously and is primary; AI supplies evidence when
// CV is ambiguous. This module reconciles a CV reading and an AI reading for
// the SAME field into a single graded outcome, following the spec's rules
// exactly:
//
//   Agreement — CV + AI agreeing corroborates the value → higher evidence band
//               (modelled as a repeated, cross-consistent read, §30).
//   Conflict  — DO NOT average conflicting values. Hold (confirm nothing new),
//               preserve confirmed state, and surface the conflict for logging.
//   Authority — This produces a candidate reading + evidence only; the
//               reconstruction validators still decide confirmation downstream.
//   Field     — §29 policy: numeric telemetry (timer, net worth, player KDA,
//               objectives) is CV-primary; draft/event semantics are AI-primary.
//
// Pure and dependency-free, like the rest of the engine.
// ===========================================================================

import type { ObservationField, ObservationSource } from "./types.ts";
import { gradeEvidence } from "./confidence.ts";
import type { EvidenceBand } from "./confidence.ts";

// ── Observation-row fusion ─────────────────────────────────────────────────
// Consumes persisted game_observations (both source="ocr" and source="vision")
// and produces a fused verdict per field/team/player. The caller extracts a
// comparable value from each row's normalized_value and passes rows
// newest-first per source, so the first row seen for a source is the latest.
export type ObservationRowInput = {
  field: string;
  source: string; // "ocr" | "vision" (others ignored for fusion)
  value: number | string | null;
  confidence: number | null;
  teamId?: string | null;
  playerId?: string | null;
};

export type FusedField = {
  key: string;
  field: string;
  teamId: string | null;
  playerId: string | null;
  result: FusionResult;
};

export function fuseObservationsByField(rows: ObservationRowInput[]): FusedField[] {
  const groups = new Map<string, { field: string; teamId: string | null; playerId: string | null; cv?: FusionReading; ai?: FusionReading }>();
  for (const r of rows) {
    if (r.value == null) continue;
    const teamId = r.teamId ?? null;
    const playerId = r.playerId ?? null;
    const key = `${r.field}|${teamId ?? ""}|${playerId ?? ""}`;
    const g = groups.get(key) ?? { field: r.field, teamId, playerId };
    const reading: FusionReading = { value: r.value, rawConfidence: r.confidence };
    // First occurrence per source wins (caller passes newest-first).
    if (r.source === "ocr" && !g.cv) g.cv = reading;
    else if (r.source === "vision" && !g.ai) g.ai = reading;
    groups.set(key, g);
  }
  const out: FusedField[] = [];
  for (const [key, g] of groups) {
    out.push({ key, field: g.field, teamId: g.teamId, playerId: g.playerId, result: fuseField({ field: g.field as ObservationField, cv: g.cv, ai: g.ai }) });
  }
  return out;
}

export type FieldPolicy = "cv_primary" | "ai_primary";

// §29: numeric telemetry is CV-primary (deterministic local recognition wins);
// draft and event banners are where "semantics dominate" so AI leads.
export function fieldFusionPolicy(field: ObservationField): FieldPolicy {
  switch (field) {
    case "draft_phase":
    case "kill_banner":
      return "ai_primary";
    default:
      return "cv_primary";
  }
}

// Numeric agreement tolerance per field. Counts/KDA/objectives must match
// exactly; net worth is a large independently-OCR'd number so a small window is
// allowed; the timer can be a second or two off between readers.
export function defaultTolerance(field: ObservationField): number {
  switch (field) {
    case "net_worth":
      return 1000; // gold
    case "game_timer":
      return 3; // seconds
    default:
      return 0; // exact
  }
}

export type FusionReading = { value: number | string | null; rawConfidence: number | null };

export type FusionAgreement = "agree" | "conflict" | "single" | "none";

export type FusionResult = {
  // The reading to hand to the reconstruction validator. null = hold nothing
  // new (no evidence, or a conflict that must preserve confirmed state).
  value: number | string | null;
  source: ObservationSource | null; // whose value was taken
  agreement: FusionAgreement;
  conflict: boolean; // true → caller should log and NOT confirm a new value
  band: EvidenceBand;
  score: number;
  reason: string;
};

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valuesAgree(a: number | string | null, b: number | string | null, tolerance: number): boolean {
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tolerance;
  return normalizeStr(String(a)) === normalizeStr(String(b));
}

// Fuse a CV reading and an AI reading for one field.
export function fuseField(args: {
  field: ObservationField;
  cv?: FusionReading | null;
  ai?: FusionReading | null;
  tolerance?: number;
}): FusionResult {
  const policy = fieldFusionPolicy(args.field);
  const tol = args.tolerance ?? defaultTolerance(args.field);
  const cv = args.cv && args.cv.value != null ? args.cv : null;
  const ai = args.ai && args.ai.value != null ? args.ai : null;
  const primarySource: ObservationSource = policy === "ai_primary" ? "vision" : "ocr";

  // ── Neither source has a reading ────────────────────────────────────────
  if (!cv && !ai) {
    return { value: null, source: null, agreement: "none", conflict: false, band: "UNKNOWN", score: 0, reason: "no evidence from either source" };
  }

  // ── Only one source ─────────────────────────────────────────────────────
  if (!cv || !ai) {
    const only = (cv ?? ai)!;
    const src: ObservationSource = cv ? "ocr" : "vision";
    const g = gradeEvidence({ source: src, rawConfidence: only.rawConfidence, repetition: 1, temporallyConsistent: null, crossFieldConsistent: null });
    return { value: only.value, source: src, agreement: "single", conflict: false, band: g.band, score: g.score, reason: `only ${src} present — uncorroborated` };
  }

  // ── Both present ────────────────────────────────────────────────────────
  if (valuesAgree(cv.value, ai.value, tol)) {
    // Corroboration: treat as a repeated, cross-consistent read so the band can
    // reach HIGH (§30). The primary source's value is the one carried forward.
    const primaryValue = policy === "ai_primary" ? ai.value : cv.value;
    const g = gradeEvidence({
      source: primarySource,
      rawConfidence: Math.max(cv.rawConfidence ?? 0, ai.rawConfidence ?? 0),
      repetition: 2,
      temporallyConsistent: true,
      crossFieldConsistent: true,
    });
    return { value: primaryValue, source: primarySource, agreement: "agree", conflict: false, band: g.band, score: g.score, reason: "CV and AI agree — corroborated" };
  }

  // Conflict: never average. Hold (value null), preserve confirmed state, and
  // report the disagreement so the caller can log it (§28).
  const g = gradeEvidence({ source: primarySource, rawConfidence: null, repetition: 1, temporallyConsistent: false, crossFieldConsistent: false });
  return {
    value: null,
    source: null,
    agreement: "conflict",
    conflict: true,
    band: "LOW",
    score: g.score,
    reason: `CV=${String(cv.value)} vs AI=${String(ai.value)} disagree beyond tolerance ${tol} — held, confirmed state preserved`,
  };
}
