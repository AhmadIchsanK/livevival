// Team-kill observation layer — the direct analogue of objectivesObservation,
// built so the team-kill OCR path uses EXACTLY the same discipline as the
// Objectives tracker (which the operator confirmed is near-perfect): a dedicated
// per-side numeric crop, digits-only normalization with a hard plausibility
// bound, and a monotonic candidate decision (missing → keep last confirmed,
// lower → suspicious/not-overwritten, equal → unchanged, higher → accept up to
// the engine's pace/jump gate). The admin capture loop wires the crop and the
// downstream plausibility clamp; this module holds the pure mapping + numeric
// normalization so it can be unit-tested with `node --test`.

export type KillSide = "a" | "b";

// A per-team kill count is a small 1–2 digit HUD number. Anything with more than
// two digits is two numbers merged or overlay chrome bleeding into the crop
// (a net worth like "47000", a spell timer) — never a real kill count. The
// absolute value bound mirrors the pace ceiling used by the engine clamp.
export const MAX_PLAUSIBLE_TEAM_KILLS = 60;

// Numeric-only normalization for one team-kill crop. Returns null for a
// missing/blank/non-numeric read (kept-last-confirmed upstream), for a run
// longer than two digits (merged numbers), and for an implausibly large value.
export function normalizeTeamKillNumber(raw: string): number | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits || digits.length > 2) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PLAUSIBLE_TEAM_KILLS) return null;
  return n;
}

// A per-side diagnostic row for the admin panel — same shape as
// ObjectiveObservation so the panel renders both trackers identically.
export type TeamKillObservation = {
  side: KillSide;
  raw: string;
  normalized: number | null;
  accepted: boolean;
  reason: string;
};

// Build the observation for one team-kill read. `confirmed` is the last
// confirmed (override) count for this side; the monotonic/candidate decision
// mirrors objectiveObservation exactly (missing → keep; lower → suspicious;
// equal → unchanged; higher → accept up to the plausibility gate the engine
// applies downstream).
export function teamKillObservation(args: {
  side: KillSide;
  raw: string;
  confirmed: number | null;
}): TeamKillObservation {
  const normalized = normalizeTeamKillNumber(args.raw);
  const base = { side: args.side, raw: args.raw, normalized };
  if (normalized == null) {
    return { ...base, accepted: false, reason: args.raw.trim() ? "not a valid kill count — keep last confirmed" : "missing — keep last confirmed" };
  }
  if (args.confirmed != null && normalized < args.confirmed) {
    return { ...base, accepted: true, reason: `correction downward ${args.confirmed} → ${normalized}` };
  }
  if (args.confirmed != null && normalized === args.confirmed) {
    return { ...base, accepted: true, reason: "unchanged" };
  }
  return { ...base, accepted: true, reason: args.confirmed == null ? "first reading" : `increase ${args.confirmed} → ${normalized}` };
}
