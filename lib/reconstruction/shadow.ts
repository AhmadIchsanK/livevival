// Shadow-mode divergence analysis (spec Phase 4/5) — categorizes the difference
// between what the LEGACY path confirmed and what the RECONSTRUCTION engine
// would confirm, with a full trace: observation → normalized → validation →
// candidate/rejection → confirmed. Pure; used by both the real-data replay
// tests and the live shadow adapter.
import { validateNetWorth } from "./validators/netWorth.ts";
import { validateTeamKills } from "./validators/kda.ts";
import { validateLord, validateTurtle } from "./validators/objectives.ts";

export type DivergenceCategory =
  | "LEGACY_WRONG"
  | "RECONSTRUCTION_WRONG"
  | "OCR_AMBIGUITY"
  | "TIMING_ALIGNMENT"
  | "MISSING_OBSERVATION"
  | "DATA_MAPPING_BUG"
  | "EXPECTED_DIFFERENCE";

export type Divergence = {
  field: string;
  gameTimeSeconds: number | null;
  legacy: unknown;
  reconstructed: unknown;
  category: DivergenceCategory;
  reason: string;
};

// Feed a chronological net-worth reading series (as the legacy path stored it)
// through the reconstruction net-worth validator and return the confirmed
// (monotonic, spike-guarded) sequence plus the readings that were rejected.
export function replayNetWorth(readings: number[]): {
  confirmed: number[]; // confirmed value after each reading
  finalConfirmed: number;
  rejected: { index: number; reading: number; reason: string }[];
} {
  let confirmed: number | null = null;
  const out: number[] = [];
  const rejected: { index: number; reading: number; reason: string }[] = [];
  readings.forEach((r, i) => {
    // Single/double-digit noise that the display never legitimately shows as a
    // full gold value: the real broadcast net worth is always >= 1000 by the
    // time it is worth reading, so a stored value under 1000 is a digit-drop
    // misread (e.g. "5.4K" read as "54" → stored 54, or "10.1K" as "101").
    const looksLikeDigitDrop = r < 1000;
    const res = validateNetWorth(looksLikeDigitDrop ? null : r, confirmed);
    if (res.status === "confirmed" && res.value != null) confirmed = res.value;
    else rejected.push({ index: i, reading: r, reason: looksLikeDigitDrop ? "digit-drop noise (<1000)" : res.reason });
    out.push(confirmed ?? 0);
  });
  return { confirmed: out, finalConfirmed: confirmed ?? 0, rejected };
}

// Compare legacy net worth (the last stored snapshot the public page shows)
// against the reconstruction's confirmed monotonic value.
export function divergeNetWorth(field: string, legacyLatest: number, readings: number[]): Divergence | null {
  const { finalConfirmed, rejected } = replayNetWorth(readings);
  if (finalConfirmed === legacyLatest) return null;
  // If legacy's shown value is LOWER than a value it itself previously stored,
  // legacy is showing a non-monotonic misread as the current value.
  const legacyMax = Math.max(...readings.filter((r) => r >= 1000));
  const category: DivergenceCategory = legacyLatest < legacyMax ? "LEGACY_WRONG" : "EXPECTED_DIFFERENCE";
  return {
    field,
    gameTimeSeconds: null,
    legacy: legacyLatest,
    reconstructed: finalConfirmed,
    category,
    reason:
      category === "LEGACY_WRONG"
        ? `legacy shows ${legacyLatest} but had already stored ${legacyMax}; reconstruction rejected ${rejected.length} non-monotonic/noise readings and holds ${finalConfirmed}`
        : `reconstruction holds monotonic ${finalConfirmed}; legacy latest ${legacyLatest} (${rejected.length} readings rejected)`,
  };
}

// Compare a legacy team-kills override against the reconstruction's validated
// value given the summed per-player kills.
export function divergeTeamKills(field: string, legacyOverride: number, summedPlayerKills: number): Divergence | null {
  const res = validateTeamKills(legacyOverride, null, summedPlayerKills);
  const reconstructed = res.status === "confirmed" ? res.value : summedPlayerKills;
  if (reconstructed === legacyOverride) return null;
  return {
    field,
    gameTimeSeconds: null,
    legacy: legacyOverride,
    reconstructed,
    category: legacyOverride > summedPlayerKills + 10 ? "LEGACY_WRONG" : "OCR_AMBIGUITY",
    reason: `legacy team-kills ${legacyOverride} vs ${summedPlayerKills} summed player kills → reconstruction ${res.status} (${res.reason})`,
  };
}

// Replay a series of objective reads (with minute-only timing) through the
// objective validators; report illegal transitions the legacy path accepted.
export function replayObjectives(
  reads: { type: string; minute: number }[]
): { confirmed: { type: string; minute: number }[]; rejected: { type: string; minute: number; reason: string }[] } {
  const confirmed: { type: string; minute: number }[] = [];
  const rejected: { type: string; minute: number; reason: string }[] = [];
  let turtleTotal = 0;
  let lastTurtleKill: number | null = null;
  let lastLordKill: number | null = null;
  for (const r of reads) {
    const seconds = r.minute * 60;
    if (r.type === "lord") {
      const res = validateLord(1, 0, { timerSeconds: seconds, lastLordKillSeconds: lastLordKill });
      // validateLord with current=0/target=1 only checks spawn timing; enforce
      // the respawn gap explicitly against the previous confirmed lord.
      const legal = res.status === "confirmed" && (lastLordKill == null || seconds >= lastLordKill + 180 - 5);
      if (legal) { confirmed.push(r); lastLordKill = seconds; }
      else rejected.push({ ...r, reason: lastLordKill != null ? `lord respawn <3min after ${lastLordKill}s` : res.reason });
    } else if (r.type === "turtle") {
      const res = validateTurtle(turtleTotal + 1, turtleTotal, { timerSeconds: seconds, turtleTotal, lastTurtleKillSeconds: lastTurtleKill });
      if (res.status === "confirmed") { confirmed.push(r); turtleTotal += 1; lastTurtleKill = seconds; }
      else rejected.push({ ...r, reason: res.reason });
    } else {
      confirmed.push(r); // towers: no timing constraint here
    }
  }
  return { confirmed, rejected };
}
