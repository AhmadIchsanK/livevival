// Timer validator (spec §6, §13) — the primary temporal reference.
// ---------------------------------------------------------------------------
// Rules: monotonic increase within a game; a decrease is only legal through a
// confirmed game reset (handled by the reset detector, not here). A lone OCR
// decrease is a garbled read, never a reset (spec §13 guardrail).
import type { ValidationResult } from "../types.ts";
import { ok, reject, missing } from "../types.ts";

export const TIMER_TOLERANCE_SECONDS = 5;

export type TimerContext = {
  confirmedSeconds: number | null; // last confirmed timer, null if none yet
};

// A single forward jump larger than this is treated as a garbled misread
// (e.g. "05:00" read as "50:00") and rejected — a spike to a bogus-high value
// is dangerous because monotonicity would then freeze every lower reading
// forever. The threshold is deliberately generous (20 min) so it never trips
// on a legitimately sparse gap between observations; the spec's real timer
// guarantees are monotonic-increase and decrease-only-on-reset, both enforced
// separately above. Callers sampling at a fixed fast cadence may pass a
// tighter bound via context if desired.
export const MAX_TIMER_JUMP_SECONDS = 1200;

export function validateTimer(
  reading: number | null,
  ctx: TimerContext
): ValidationResult<number> {
  if (reading == null) return missing("no timer reading — keep last confirmed");
  if (reading < 0) return reject("negative timer");
  const prev = ctx.confirmedSeconds;
  if (prev == null) return ok(reading, "first timer reading");
  if (reading < prev - TIMER_TOLERANCE_SECONDS) {
    // Decrease beyond tolerance: reject here. Only the reset detector, seeing
    // corroborating signals, may legitimately lower the timer.
    return reject(`timer decreased ${prev}s → ${reading}s (no reset confirmed)`);
  }
  if (reading <= prev) return ok(prev, "unchanged / within tolerance");
  if (reading - prev > MAX_TIMER_JUMP_SECONDS) {
    return reject(`implausible forward jump ${prev}s → ${reading}s in one tick`);
  }
  return ok(reading, "monotonic increase");
}
