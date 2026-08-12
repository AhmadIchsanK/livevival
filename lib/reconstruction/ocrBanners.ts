// Pure OCR text interpreters for center-of-screen banners — kept dependency-free
// so both the admin capture loop and the test runner can use them. MLBB's
// SAVAGE/MANIAC/kill-streak banners and the REPLAY/PAUSE/VICTORY overlays are
// heavily stylized, so all matching is done against a letters-only, uppercased
// normalization with tolerant substrings rather than strict word boundaries.

export const KILL_BANNER_KEYWORDS: { needles: string[]; type: string }[] = [
  { needles: ["SAVAGE"], type: "savage" },
  { needles: ["MANIAC"], type: "maniac" },
  { needles: ["TRIPLEKILL", "TRIPLE"], type: "triple_kill" },
  { needles: ["DOUBLEKILL", "DOUBLE"], type: "double_kill" },
];

export function normalizeBannerText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, "");
}

export function bannerMatch(text: string): { type: string } | null {
  const norm = normalizeBannerText(text);
  if (!norm) return null;
  for (const k of KILL_BANNER_KEYWORDS) {
    if (k.needles.some((n) => norm.includes(n))) return { type: k.type };
  }
  return null;
}

// Center-of-screen match-state detector (the "match_event" tracker). Reads the
// middle of the broadcast where MLBB shows a REPLAY indicator, a PAUSE overlay,
// and the end-game VICTORY/DEFEAT banner (which appears the instant the base
// crystal is destroyed). Crystal/end-game wins over replay/pause when ambiguous.
export function detectMatchState(text: string): "crystal" | "replay" | "pause" | null {
  const norm = normalizeBannerText(text);
  if (!norm) return null;
  if (norm.includes("VICTORY") || norm.includes("DEFEAT") || norm.includes("CRYSTAL")) return "crystal";
  if (norm.includes("REPLAY")) return "replay";
  if (norm.includes("PAUSE")) return "pause";
  return null;
}
