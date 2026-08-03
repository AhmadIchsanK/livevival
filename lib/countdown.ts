// HH:MM:SS, uncapped hours (a match ~23h away shows "23:59:59", not a
// truncated/wrapped value) — shared by the home page's Upcoming cards and
// the match detail page's own header countdown so both read identically.
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const COUNTDOWN_WINDOW_MS = 24 * 60 * 60 * 1000;
