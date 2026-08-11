// Single source of truth for match/game phase logic — which phase can move
// to which, and why a given move is or isn't currently legal. Both the
// admin live console (to drive its phase control bar) and, in principle,
// the public page (to reason about what a phase means) read from this
// instead of each re-deriving the same rules inline.
//
// This module is pure and framework-free: it takes a small serializable
// "signals" object describing the match's current situation and returns
// which of the 8 canonical phases are reachable right now, with a
// human-readable reason attached to every one that isn't. The actual
// database writes, Telegram posts, and moment-log entries for a
// transition stay owned by the live console (see handlePhaseChange /
// setMatchPhase there) — this module only answers "is this move legal."

export const MATCH_PHASES = [
  "MATCH_NOT_STARTED",
  "DRAFT_STARTED",
  "DRAFT_COMPLETE",
  "GAME_STARTED",
  "TECHNICAL_PAUSE",
  "GAME_FINISHED",
  "SERIES_FINISHED",
] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

export const PHASE_LABELS: Record<MatchPhase, string> = {
  MATCH_NOT_STARTED: "Not started",
  DRAFT_STARTED: "Draft",
  DRAFT_COMPLETE: "Draft complete",
  GAME_STARTED: "Game ongoing",
  TECHNICAL_PAUSE: "Technical pause",
  GAME_FINISHED: "Game finished",
  SERIES_FINISHED: "Match finished",
};

// Short imperative verb for the phase-stepper button that MAKES this phase
// current (distinct from the label, which describes the phase once it IS
// current) — "Start draft" reads as an action, "Draft" reads as a state.
export const PHASE_ACTION_LABELS: Partial<Record<MatchPhase, string>> = {
  DRAFT_STARTED: "Start draft",
  DRAFT_COMPLETE: "Lock draft",
  GAME_STARTED: "Start game",
  TECHNICAL_PAUSE: "Pause game",
  GAME_FINISHED: "Finish game",
  SERIES_FINISHED: "Finish match",
};

// Everything a guard might need to know, gathered once per render by the
// caller (see live console's phaseSignals) instead of every guard reaching
// into component state directly — keeps this module testable in isolation.
export type PhaseSignals = {
  currentPhase: MatchPhase;
  hasBothTeams: boolean;
  rosterReady: boolean; // exactly 5 active players a side
  draftFullyResolved: boolean; // all 10 starters have a locked-in hero
  hasStreamUrl: boolean;
  currentGameHasWinner: boolean;
  seriesWinsRequired: number;
  teamAGameWins: number;
  teamBGameWins: number;
  isLastGameOfSeries: boolean; // true once either side is one win away
};

export type PhaseTransition = {
  phase: MatchPhase;
  legal: boolean;
  // Present only when legal is false — why the button should stay disabled.
  blockedReason: string | null;
};

// One reusable "does either side already have the series win?" check —
// SERIES_FINISHED is reachable from GAME_FINISHED once true, and the
// stepper needs the same answer to decide whether to skip straight to it.
function seriesWinner(s: PhaseSignals): "a" | "b" | null {
  if (s.teamAGameWins >= s.seriesWinsRequired) return "a";
  if (s.teamBGameWins >= s.seriesWinsRequired) return "b";
  return null;
}

// The forward path every match/game takes under normal play. Branches
// (TECHNICAL_PAUSE, back to DRAFT_STARTED for the next game) are handled
// as special cases in getLegalTransitions below, not in this list —
// keeping the "happy path" readable as a straight line.
const FORWARD_SEQUENCE: MatchPhase[] = [
  "MATCH_NOT_STARTED",
  "DRAFT_STARTED",
  "DRAFT_COMPLETE",
  "GAME_STARTED",
  "GAME_FINISHED",
  "SERIES_FINISHED",
];

// Evaluates every one of the 8 canonical phases against the current phase +
// signals, returning why each one that isn't reachable right now is
// blocked. The live console renders this directly as its phase-stepper —
// one row per phase, disabled with a tooltip when blockedReason is set.
export function getLegalTransitions(signals: PhaseSignals): PhaseTransition[] {
  const { currentPhase } = signals;

  function evaluate(phase: MatchPhase): PhaseTransition {
    if (phase === currentPhase) return { phase, legal: true, blockedReason: null };

    // SERIES_FINISHED is terminal — the live console's own "Reset match"
    // action (a separate, explicit destructive control, not a phase move)
    // is the only way out, matching the existing product decision.
    if (currentPhase === "SERIES_FINISHED") {
      return { phase, legal: false, blockedReason: "This match is finished — use Reset match to change its phase." };
    }

    switch (phase) {
      case "MATCH_NOT_STARTED": {
        // Back to roster review before the next game's draft starts — a
        // non-destructive lateral move (unlike Reset match, which wipes
        // every game/pick/stat for the whole series). current_game_number
        // already points at the next game by this point (declareGameWinner
        // advances it when closing out the previous one), so this just
        // re-shows the roster-setup UI scoped to that upcoming game — the
        // just-finished game's own data is untouched, it's a different
        // game_id.
        if (currentPhase === "GAME_FINISHED" && !signals.isLastGameOfSeries) return { phase, legal: true, blockedReason: null };
        // Otherwise only reachable via Reset — a draft or game already in
        // progress has real data attached (roster locks, picks, kills)
        // that a plain phase click shouldn't silently discard.
        return { phase, legal: false, blockedReason: "Use Reset match to return to Not started." };
      }

      case "DRAFT_STARTED": {
        if (currentPhase === "MATCH_NOT_STARTED") {
          if (!signals.hasBothTeams) return { phase, legal: false, blockedReason: "Both teams must be set on this match first." };
          if (!signals.rosterReady) return { phase, legal: false, blockedReason: "Both teams need exactly 5 active roster players." };
          return { phase, legal: true, blockedReason: null };
        }
        // Re-entering the draft from DRAFT_COMPLETE (correcting a pick
        // before locking) stays legal — nothing downstream depends on it
        // yet since GAME_STARTED hasn't happened.
        if (currentPhase === "DRAFT_COMPLETE") return { phase, legal: true, blockedReason: null };
        // Starting the NEXT game's draft, once the previous one finished
        // and the series isn't over.
        if (currentPhase === "GAME_FINISHED" && !signals.isLastGameOfSeries) return { phase, legal: true, blockedReason: null };
        return { phase, legal: false, blockedReason: `Can't start a draft from ${PHASE_LABELS[currentPhase]}.` };
      }

      case "DRAFT_COMPLETE": {
        if (currentPhase !== "DRAFT_STARTED") return { phase, legal: false, blockedReason: "Draft must be in progress first." };
        if (!signals.draftFullyResolved) {
          return { phase, legal: false, blockedReason: "All 10 starters need a locked-in hero before the draft can finish." };
        }
        return { phase, legal: true, blockedReason: null };
      }

      case "GAME_STARTED": {
        if (currentPhase === "TECHNICAL_PAUSE") return { phase, legal: true, blockedReason: null };
        if (currentPhase !== "DRAFT_COMPLETE") return { phase, legal: false, blockedReason: "Lock the draft first." };
        if (!signals.draftFullyResolved) return { phase, legal: false, blockedReason: "All 10 starters need a locked-in hero." };
        if (!signals.hasStreamUrl) return { phase, legal: false, blockedReason: "Add a stream link before going live." };
        return { phase, legal: true, blockedReason: null };
      }

      case "TECHNICAL_PAUSE":
        if (currentPhase !== "GAME_STARTED") return { phase, legal: false, blockedReason: "Technical pause is only available from Game ongoing." };
        return { phase, legal: true, blockedReason: null };

      case "GAME_FINISHED": {
        if (currentPhase !== "GAME_STARTED" && currentPhase !== "TECHNICAL_PAUSE") {
          return { phase, legal: false, blockedReason: "Finish the game from Game ongoing, once a winner is decided." };
        }
        if (!signals.currentGameHasWinner) return { phase, legal: false, blockedReason: "Declare this game's winner first." };
        return { phase, legal: true, blockedReason: null };
      }

      case "SERIES_FINISHED": {
        if (currentPhase !== "GAME_FINISHED") return { phase, legal: false, blockedReason: "A game must finish first." };
        if (!seriesWinner(signals)) {
          return {
            phase,
            legal: false,
            blockedReason: `Neither team has reached ${signals.seriesWinsRequired} game win(s) yet.`,
          };
        }
        return { phase, legal: true, blockedReason: null };
      }
    }
  }

  return MATCH_PHASES.map(evaluate);
}

// Convenience for a single yes/no check (e.g. gating a specific button)
// without pulling the full 8-row table.
export function canTransitionTo(signals: PhaseSignals, target: MatchPhase): PhaseTransition {
  return getLegalTransitions(signals).find((t) => t.phase === target)!;
}

// Where FORWARD_SEQUENCE is actually consulted — the stepper's "what's
// next" shorthand, e.g. for a single primary "Advance" button alongside
// the full per-phase row. Returns null at the end of the sequence (game
// finished + series decided) or while in a branch phase (TECHNICAL_PAUSE)
// that has its own explicit return path instead of a "next."
export function nextForwardPhase(current: MatchPhase): MatchPhase | null {
  if (current === "TECHNICAL_PAUSE") return "GAME_STARTED";
  const idx = FORWARD_SEQUENCE.indexOf(current);
  if (idx === -1 || idx === FORWARD_SEQUENCE.length - 1) return null;
  return FORWARD_SEQUENCE[idx + 1];
}
