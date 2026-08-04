"use client";

import type { ViewMode } from "@/lib/useViewMode";

// Two icon buttons sharing one bordered pill — same visual language as the
// existing .lv-btn-ghost controls (border/hover/active states), just
// grouped into a single segmented control instead of two separate buttons.
export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="flex items-center border border-white/15 rounded-md overflow-hidden shrink-0" role="group" aria-label="Layout">
      <button
        type="button"
        onClick={() => onChange("grid")}
        aria-pressed={mode === "grid"}
        title="Grid view"
        className={`flex items-center justify-center px-2.5 py-2 transition-colors duration-200 ${
          mode === "grid" ? "bg-signal/20 text-signal" : "text-white/50 hover:text-white hover:bg-white/5"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={mode === "list"}
        title="List view"
        className={`flex items-center justify-center px-2.5 py-2 border-l border-white/15 transition-colors duration-200 ${
          mode === "list" ? "bg-signal/20 text-signal" : "text-white/50 hover:text-white hover:bg-white/5"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1" y="1.5" width="14" height="2.5" rx="1" fill="currentColor" />
          <rect x="1" y="6.75" width="14" height="2.5" rx="1" fill="currentColor" />
          <rect x="1" y="12" width="14" height="2.5" rx="1" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}
