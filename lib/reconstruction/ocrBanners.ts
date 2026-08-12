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

export type MatchState = "crystal" | "replay" | "pause";

// End-game keywords MLBB shows the instant the base crystal falls. VICTORY /
// DEFEAT are the primary banners; CRYSTAL/BASE/DESTROYED cover the base-fall
// callout on overlays that render it. These NEVER appear mid-game, so matching
// any of them is a reliable end-of-game signal (a false GAME_FINISHED is worse
// than a missed one — see spec §E — so the set is deliberately end-game-only).
const CRYSTAL_KEYWORDS = ["VICTORY", "DEFEAT", "CRYSTAL", "BASEDESTROYED", "GAMEOVER"];
const REPLAY_KEYWORDS = ["REPLAY", "INSTANTREPLAY"];
const PAUSE_KEYWORDS = ["PAUSE", "PAUSED", "TECHNICALPAUSE"];

// Detailed detector exposing WHICH keyword matched, for the admin diagnostics
// panel (RAW → NORMALIZED → MATCHED KEYWORD → DETECTED STATE). Crystal/end-game
// wins over replay/pause when ambiguous.
export function detectMatchStateDetailed(text: string): { state: MatchState | null; keyword: string | null; normalized: string } {
  const norm = normalizeBannerText(text);
  if (!norm) return { state: null, keyword: null, normalized: norm };
  for (const kw of CRYSTAL_KEYWORDS) if (norm.includes(kw)) return { state: "crystal", keyword: kw, normalized: norm };
  for (const kw of REPLAY_KEYWORDS) if (norm.includes(kw)) return { state: "replay", keyword: kw, normalized: norm };
  for (const kw of PAUSE_KEYWORDS) if (norm.includes(kw)) return { state: "pause", keyword: kw, normalized: norm };
  return { state: null, keyword: null, normalized: norm };
}

// Center-of-screen match-state detector (the "match_event" tracker). Reads the
// middle of the broadcast where MLBB shows a REPLAY indicator, a PAUSE overlay,
// and the end-game VICTORY/DEFEAT banner (which appears the instant the base
// crystal is destroyed). Crystal/end-game wins over replay/pause when ambiguous.
export function detectMatchState(text: string): MatchState | null {
  return detectMatchStateDetailed(text).state;
}
