"use client";

import { useEffect, useState } from "react";

export type ViewMode = "grid" | "list";

// Persists a grid/list toggle choice to localStorage per storage key (one
// key per page — /heroes, /players, /teams each remember their own
// choice independently). Reads from localStorage after mount only (not
// during the initial render) so server-rendered and first-client-render
// HTML match — avoids a hydration mismatch, at the cost of one extra
// render right after mount when a stored preference differs from the
// default.
export function useViewMode(storageKey: string, defaultMode: ViewMode = "grid"): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(defaultMode);

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "grid" || stored === "list") setMode(stored);
  }, [storageKey]);

  function update(next: ViewMode) {
    setMode(next);
    window.localStorage.setItem(storageKey, next);
  }

  return [mode, update];
}
