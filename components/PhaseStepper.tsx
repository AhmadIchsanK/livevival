"use client";

import type { MatchPhase, PhaseTransition } from "@/lib/matchPhase";
import { PHASE_LABELS, PHASE_ACTION_LABELS } from "@/lib/matchPhase";

// Replaces the old plain phase <select> — every phase is a pill in one
// row, the current one solid/highlighted, legal moves clickable, illegal
// ones visibly disabled with the reason as a tooltip instead of a raw
// dropdown that let an admin pick an illegal phase and find out why only
// after the fact via a toast. See lib/matchPhase for the actual rules.
export function PhaseStepper({
  transitions,
  current,
  onSelect,
  disabled,
}: {
  transitions: PhaseTransition[];
  current: MatchPhase;
  onSelect: (phase: MatchPhase) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5" role="group" aria-label="Match phase">
      {transitions.map((t) => {
        const isCurrent = t.phase === current;
        const clickable = !isCurrent && t.legal && !disabled;
        return (
          <button
            key={t.phase}
            type="button"
            disabled={!clickable}
            onClick={clickable ? () => onSelect(t.phase) : undefined}
            title={isCurrent ? undefined : t.legal ? (PHASE_ACTION_LABELS[t.phase] ?? `Go to ${PHASE_LABELS[t.phase]}`) : t.blockedReason ?? undefined}
            className={`shrink-0 text-[10px] px-2 py-1.5 sm:py-1 rounded border uppercase tracking-wide transition-colors whitespace-nowrap ${
              isCurrent
                ? "border-signal bg-signal/25 text-signal font-semibold"
                : t.legal
                ? "border-white/20 text-white/70 hover:border-signal/60 hover:bg-signal/10 hover:text-white cursor-pointer"
                : "border-white/5 text-white/20 cursor-not-allowed"
            }`}
          >
            {isCurrent ? "● " : ""}
            {PHASE_LABELS[t.phase]}
          </button>
        );
      })}
    </div>
  );
}
