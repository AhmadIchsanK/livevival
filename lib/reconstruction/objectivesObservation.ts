// Objectives observation layer — the combined "Objectives" tracker is ONE
// tracker in the admin UI but internally six small numeric OCR sub-regions:
//   LEFT :  Turtle / Lord / Tower
//   RIGHT:  Tower  / Lord / Turtle
// Each sub-region crops ONLY the number beside its icon and is OCR'd digits-only
// and normalized independently — never one OCR pass over the whole strip. This
// module holds the pure mapping + numeric normalization; the admin capture loop
// wires the crops, and the (unchanged) reconstruction validators enforce
// monotonicity / spawn-timing / caps downstream.

export type ObjType = "turtle" | "lord" | "tower";
export type ObjSide = "left" | "right";

// Broadcast reading order per side (explicit semantic mapping — never inferred
// from the icon image). LEFT: Turtle, Lord, Tower. RIGHT mirrors it.
export const OBJECTIVE_SIDE_ORDER: Record<ObjSide, ObjType[]> = {
  left: ["turtle", "lord", "tower"],
  right: ["tower", "lord", "turtle"],
};

// Field key for one numeric sub-region, e.g. "objective_num_left_turtle".
export function objectiveNumField(side: ObjSide, type: ObjType): string {
  return `objective_num_${side}_${type}`;
}

// The three sub-region fields for a side, in broadcast order.
export function objectiveNumFieldsForSide(side: ObjSide): { type: ObjType; field: string }[] {
  return OBJECTIVE_SIDE_ORDER[side].map((type) => ({ type, field: objectiveNumField(side, type) }));
}

// Parse side + type back out of a sub-region field key.
export function parseObjectiveNumField(field: string): { side: ObjSide; type: ObjType } | null {
  const m = field.match(/^objective_num_(left|right)_(turtle|lord|tower)$/);
  if (!m) return null;
  return { side: m[1] as ObjSide, type: m[2] as ObjType };
}

// Numeric-only normalization for a single objective sub-region. The crop should
// contain ONLY the number, so strip everything but digits and read the result.
// Returns null for a missing/blank/non-numeric read (kept-last-confirmed
// upstream), and rejects an implausibly large value (a stray glyph merging into
// the number) — no single objective count is ever this high.
export const MAX_PLAUSIBLE_OBJECTIVE = 20;

export function normalizeObjectiveNumber(raw: string): number | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PLAUSIBLE_OBJECTIVE) return null;
  return n;
}

// A per-sub-region diagnostic row for the admin panel.
export type ObjectiveObservation = {
  side: ObjSide;
  type: ObjType;
  raw: string;
  normalized: number | null;
  accepted: boolean;
  reason: string;
};

// Build the diagnostic/observation for one sub-region read. `confirmed` is the
// last confirmed count for this side+type; the monotonic/candidate decision
// mirrors the spec (missing → keep; lower → suspicious; higher → accept up to
// the plausibility gate applied by the engine).
export function objectiveObservation(args: {
  side: ObjSide;
  type: ObjType;
  raw: string;
  confirmed: number | null;
}): ObjectiveObservation {
  const normalized = normalizeObjectiveNumber(args.raw);
  const base = { side: args.side, type: args.type, raw: args.raw, normalized };
  if (normalized == null) {
    return { ...base, accepted: false, reason: args.raw.trim() ? "not a valid number — keep last confirmed" : "missing — keep last confirmed" };
  }
  if (args.confirmed != null && normalized < args.confirmed) {
    return { ...base, accepted: false, reason: `below confirmed ${args.confirmed} — suspicious, not overwritten (needs reset)` };
  }
  if (args.confirmed != null && normalized === args.confirmed) {
    return { ...base, accepted: true, reason: "unchanged" };
  }
  return { ...base, accepted: true, reason: args.confirmed == null ? "first reading" : `increase ${args.confirmed} → ${normalized}` };
}
