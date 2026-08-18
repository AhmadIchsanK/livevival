// Pure OCR text interpreters for center-of-screen banners — kept dependency-free
// so both the admin capture loop and the test runner can use them. MLBB's
// SAVAGE/MANIAC/kill-streak banners and the REPLAY/PAUSE/VICTORY overlays are
// heavily stylized, so all matching is done against a letters-only, uppercased
// normalization with tolerant substrings rather than strict word boundaries.

// Full words PLUS one-edge-letter-dropped stems, so a heavily-stylized banner
// that OCR returns a letter short still matches. Order matters: the more
// specific streak words (ACE, MANIAC) are unambiguous; DOUBLE/TRIPLE stems are
// checked as whole-ish tokens. Stems are chosen to be very unlikely to appear
// in unrelated center-screen text.
export const KILL_BANNER_KEYWORDS: { needles: string[]; type: string }[] = [
  { needles: ["SAVAGE", "SAVAG", "AVAGE"], type: "savage" },
  { needles: ["MANIAC", "MANIA", "ANIAC"], type: "maniac" },
  { needles: ["TRIPLEKILL", "TRIPLE", "TRIPL", "RIPLE"], type: "triple_kill" },
  { needles: ["DOUBLEKILL", "DOUBLE", "DOUBL", "OUBLE"], type: "double_kill" },
];

export function normalizeBannerText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, "");
}

// Like normalizeBannerText but also maps the common OCR digit-for-letter
// confusions to letters (a stylized "SAVAGE" often reads "5AVAGE", "MANIAC" as
// "MAN1AC") before stripping, so a partly-numeric read still matches a needle.
function normalizeBannerGlyphs(text: string): string {
  return text
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B")
    .replace(/4/g, "A")
    .replace(/[^A-Z]/g, "");
}

export function bannerMatch(text: string): { type: string } | null {
  const norm = normalizeBannerGlyphs(text);
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
// Stylized broadcast overlays OCR imperfectly — a heavy VICTORY glyph routinely
// comes back missing its first or last letter, and digit-for-letter confusions
// (0→O, 1→I, 5→S, 8→B) are common on chrome fonts. So each state carries a few
// tolerant STEMS (a word with one edge letter dropped) alongside the full word,
// and normalization maps the common digit confusions to letters before
// stripping. This lifts recall on a partial read without needing the whole word
// perfectly. Kept conservative on the crystal set (a false GAME_FINISHED is
// worse than a missed one, spec §E) — the caller still requires two consecutive
// crystal frames before finishing, which absorbs a stray single-frame match.
const CRYSTAL_KEYWORDS = ["VICTORY", "VICTOR", "ICTORY", "DEFEAT", "DEFEA", "EFEAT", "CRYSTAL", "CRYSTA", "BASEDESTROYED", "GAMEOVER"];
const REPLAY_KEYWORDS = ["REPLAY", "REPLA", "EPLAY", "INSTANTREPLAY"];
const PAUSE_KEYWORDS = ["PAUSED", "PAUSE", "TECHNICALPAUSE", "PAUS"];

// Match-state normalization maps the common OCR digit-for-letter confusions to
// letters (a stylized "VICTORY" often reads "V1CT0RY") before stripping to
// A-Z. Deliberately separate from normalizeBannerText so the kill-banner path
// (which reads different fonts) keeps its stricter letters-only behavior.
function normalizeStateText(text: string): string {
  return text
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B")
    .replace(/[^A-Z]/g, "");
}

// Detailed detector exposing WHICH keyword matched, for the admin diagnostics
// panel (RAW → NORMALIZED → MATCHED KEYWORD → DETECTED STATE). Crystal/end-game
// wins over replay/pause when ambiguous.
export function detectMatchStateDetailed(text: string): { state: MatchState | null; keyword: string | null; normalized: string } {
  const norm = normalizeStateText(text);
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

// Maps an AI-vision phase label (the fallback observer, spec §16/§25/§27 — used
// when the deterministic keyword read above comes back empty on a stylized
// overlay) to the same MatchState the OCR path produces, so both feed one
// handler. The AI classifier answers with one of a small fixed vocabulary; a
// LIVE / normal-gameplay / unknown answer maps to null (no state change).
// Kept deliberately narrow: only the end-game screen counts as "crystal", and
// only explicit replay/pause labels suspend telemetry — anything ambiguous is
// treated as live, so the AI fallback can never itself finish a game on a guess.
export function phaseToMatchState(phase: string | null | undefined): MatchState | null {
  if (!phase) return null;
  const p = phase.toUpperCase().replace(/[^A-Z]/g, "");
  if (p.includes("REPLAY")) return "replay";
  if (p.includes("PAUSE")) return "pause";
  if (p.includes("VICTORY") || p.includes("DEFEAT") || p.includes("POSTGAME") || p.includes("GAMEOVER") || p.includes("ENDGAME")) {
    return "crystal";
  }
  return null; // LIVE / IN_GAME / DRAFT / LOADING / LOBBY / UNKNOWN → no state
}
