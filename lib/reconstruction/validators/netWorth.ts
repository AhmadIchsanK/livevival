// Net worth validator (spec §5, §15).
// ---------------------------------------------------------------------------
// Net worth is normally monotonic during a game. Missing → keep confirmed.
// Single-digit noise is already rejected at normalization. Here we guard
// against implausible spikes: a real burst (team wipe + objective) adds a few
// thousand gold, but a jump far beyond that in one tick is a misread digit
// ("1.2K" → "120K"). Clamp to a per-tick ceiling and hold the raw as candidate
// rather than overwriting confirmed state with a suspicious spike.
import type { ValidationResult } from "../types.ts";

export const MAX_NET_WORTH_GAIN_PER_TICK = 8000;

export function validateNetWorth(
  reading: number | null,
  confirmed: number | null
): ValidationResult<number> {
  if (reading == null) return { status: "missing", value: confirmed, reason: "no reading — keep confirmed" };
  if (reading < 0) return { status: "rejected", value: confirmed, reason: "negative" };
  if (confirmed == null) return { status: "confirmed", value: reading, reason: "first reading" };
  if (reading < confirmed) {
    return { status: "rejected", value: confirmed, reason: `decrease ${confirmed} → ${reading}` };
  }
  if (reading - confirmed > MAX_NET_WORTH_GAIN_PER_TICK) {
    return {
      status: "candidate",
      value: confirmed + MAX_NET_WORTH_GAIN_PER_TICK,
      reason: `spike +${reading - confirmed} exceeds ${MAX_NET_WORTH_GAIN_PER_TICK}/tick`,
    };
  }
  return { status: "confirmed", value: reading, reason: "ok" };
}
