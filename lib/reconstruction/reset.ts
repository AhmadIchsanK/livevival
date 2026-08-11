// Reset detector (spec §10, §18, §44) — isolates games so Game 2 can never
// corrupt Game 1. A value may only decrease after a new game is CONFIRMED, and
// a single OCR decrease is never sufficient proof on its own.
// ---------------------------------------------------------------------------
// Multiple corroborating signals are combined; a reset is only declared when
// the evidence is strong. On confirmation the caller archives the old game
// state/events and starts a fresh game context (ARCHIVE → RESET → START).
export type ResetSignals = {
  // The timer read dropped far below the confirmed timer (e.g. 15:42 → 00:05).
  timerDropped: boolean;
  // Draft/loading screen detected (vision observation).
  draftScreenDetected: boolean;
  // Scoreboard/all-player-stats read as zero while confirmed state is non-zero.
  scoreboardZeroed: boolean;
  // The game id / match context changed (authoritative — admin started a game).
  gameIdChanged: boolean;
  // Explicit admin "start new game" action.
  adminStartedGame: boolean;
};

export const NO_SIGNALS: ResetSignals = {
  timerDropped: false,
  draftScreenDetected: false,
  scoreboardZeroed: false,
  gameIdChanged: false,
  adminStartedGame: false,
};

export type ResetVerdict = {
  isReset: boolean;
  confidence: number; // 0..1
  reasons: string[];
};

// Authoritative signals (gameIdChanged, adminStartedGame) are sufficient alone.
// Inferred signals (timer/draft/scoreboard) require at least two agreeing, so a
// lone timer glitch never triggers a reset (spec §18 guardrail).
export function detectReset(signals: ResetSignals): ResetVerdict {
  const reasons: string[] = [];
  if (signals.gameIdChanged) reasons.push("game id changed");
  if (signals.adminStartedGame) reasons.push("admin started new game");
  if (reasons.length > 0) {
    return { isReset: true, confidence: 1, reasons };
  }

  const inferred: string[] = [];
  if (signals.timerDropped) inferred.push("timer reset to near zero");
  if (signals.draftScreenDetected) inferred.push("draft/loading screen");
  if (signals.scoreboardZeroed) inferred.push("scoreboard zeroed");

  if (inferred.length >= 2) {
    return { isReset: true, confidence: 0.5 + 0.15 * inferred.length, reasons: inferred };
  }
  return {
    isReset: false,
    confidence: inferred.length === 1 ? 0.3 : 0,
    reasons: inferred.length === 1 ? [`single weak signal (${inferred[0]}) — not enough`] : [],
  };
}
