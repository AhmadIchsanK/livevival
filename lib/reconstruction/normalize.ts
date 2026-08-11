// LIVEVIVAL — Reconstruction Engine — normalization layer (spec §11)
// ===========================================================================
// Turns messy OCR output into typed candidate values. This is the ONLY place
// that parses OCR strings — every downstream validator sees a NormalizedValue,
// never raw text. Formatting logic lives here; validation logic does not
// (spec §11 guardrail: do not mix formatting with validation).
//
// OCR input rules (spec §1): OCR may recognize ONLY
//   K/D/A:      digits + "/"
//   Net Worth:  digits + "."
//   Game Timer: digits + ":"
// All letters and unrelated characters are ignored.
// ===========================================================================

import type { KdaValue, TimerValue, NetWorthValue, CountValue } from "./types.ts";

// ── Game timer (spec §6) ────────────────────────────────────────────────────
// Format MM:SS. ":" is mandatory; seconds must be 00–59. Anything else is not a
// timer reading at all (returns null, treated as MISSING upstream), never a
// value to clamp.
export function normalizeTimer(raw: string): TimerValue | null {
  const cleaned = raw.replace(/[^0-9:]/g, "");
  const m = cleaned.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mm = Number(m[1]);
  const ss = Number(m[2]);
  if (ss > 59) return null; // SS out of range → misread, not a real timestamp
  return { kind: "timer", seconds: mm * 60 + ss };
}

export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ── K/D/A (spec §1, §4) ─────────────────────────────────────────────────────
// Only a strict digits-and-slash "N/N/N" counts. Any other separator is a
// misread and rejected (returns null). Letters are stripped first.
export function normalizeKda(raw: string): KdaValue | null {
  const cleaned = raw.replace(/[^0-9/]/g, "");
  const m = cleaned.match(/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return { kind: "kda", kills: Number(m[1]), deaths: Number(m[2]), assists: Number(m[3]) };
}

// Split a combined KDA-group region (5 rows, one OCR pass) into per-row
// readings by line. Only lines matching the strict N/N/N shape count; anything
// else (a spell cooldown, a garbled row) is dropped rather than guessed at.
export function normalizeKdaGroup(raw: string): KdaValue[] {
  return raw
    .split(/\r?\n+/)
    .map((line) => normalizeKda(line))
    .filter((k): k is KdaValue => k !== null);
}

// ── Net worth (spec §5) ─────────────────────────────────────────────────────
// Public display is xx.xK; internal storage is a full integer.
//   OCR "55"  → 5500  → "5.5K"   (2 digits → one-decimal K)
//   OCR "127" → 12700 → "12.7K"  (3 digits → two-digit integer + one decimal)
//   OCR "341" → 34100 → "34.1K"
// A single OCR digit is rejected as noise: the broadcast display always shows
// at least two digits, so one digit is a partial/garbled read, not a real 0.9K.
// If OCR already contains a decimal point (e.g. "34.1"), it is read directly as
// thousands.
export function normalizeNetWorth(raw: string): NetWorthValue | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  if (cleaned.includes(".")) {
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    return { kind: "net_worth", gold: Math.round(n * 1000) };
  }
  if (cleaned.length < 2) return null; // single-digit noise (spec §5, §15)
  return { kind: "net_worth", gold: Number(cleaned) * 100 };
}

export function formatNetWorth(gold: number): string {
  return `${(gold / 1000).toFixed(1)}K`;
}

// ── Counts (team kills, objective tallies) ──────────────────────────────────
// Plain non-negative integer. Optional bound rejects absurd reads (a stray
// digit from overlay chrome) before they reach validation.
export function normalizeCount(raw: string, max = 999): CountValue | null {
  const cleaned = raw.replace(/[^0-9]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return { kind: "count", count: n };
}

// Split an objectives-group region ("tower lord turtle" cluster) into its three
// numbers, in reading order. Requires exactly three digit runs, or returns null
// (a partial read must not be silently misassigned to the wrong objective).
export function normalizeObjectivesGroup(raw: string): [number, number, number] | null {
  const runs = raw.match(/\d+/g);
  if (!runs || runs.length !== 3) return null;
  return [Number(runs[0]), Number(runs[1]), Number(runs[2])];
}

// Normalize a Tesseract-style confidence (0..100) or an already-0..1 value into
// a uniform 0..1 scale. null passes through (unknown confidence).
export function normalizeConfidence(c: number | null | undefined): number | null {
  if (c == null || !Number.isFinite(c)) return null;
  if (c > 1) return Math.max(0, Math.min(1, c / 100));
  return Math.max(0, Math.min(1, c));
}
