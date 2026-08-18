// Pure OCR text → K/D/A parsing, shared by the admin capture loop and its
// tests. Kept dependency-free (erasable TS) so `node --test` can run it.
//
// The scoreboard row OCR often carries more than the K/D/A on the same line
// (the player's net worth, a spell-cooldown digit, the hero name). The matcher
// pins the strict "N/N/N" shape with 1-2 digit fields and a trailing guard so a
// longer number fused onto the third field (a net worth) is rejected rather
// than misread as assists — e.g. "0/0/0 2956" reads 0/0/0, not 0/0/2956.

export type Kda = { kills: number; deaths: number; assists: number };

// Look-alike letters OCR commonly substitutes for KDA digits on stylized
// scoreboard fonts. Mapping is applied ONLY as a fallback (see parseKda): since
// letters can't produce the required "/" separators, this can never fabricate a
// KDA out of a hero name — it only rescues a genuine N/N/N row whose digits were
// misread as letters (e.g. "O/O/O" → 0/0/0, "l0/2/3" → 10/2/3).
const KDA_DIGIT_GLYPHS: Record<string, string> = { O: "0", o: "0", I: "1", l: "1", S: "5", B: "8", Z: "2" };

function matchKdaShape(s: string): Kda | null {
  // 1-2 digits per field; the trailing (?![\d/]) rejects a longer run (a net
  // worth) fused onto the third number instead of misreading it as assists.
  const m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  return m ? { kills: Number(m[1]), deaths: Number(m[2]), assists: Number(m[3]) } : null;
}

export function parseKda(text: string): Kda | null {
  const direct = matchKdaShape(text);
  if (direct) return direct;
  // Fallback: recover a row where a KDA digit was OCR'd as a look-alike letter.
  const normalized = text.replace(/[OoIlSBZ]/g, (c) => KDA_DIGIT_GLYPHS[c] ?? c);
  return matchKdaShape(normalized);
}

// One region spanning all five KDA rows, split back into per-row readings by
// line. Only real "N/N/N" lines count — a garbled/partial row simply doesn't
// match the shape and is dropped rather than guessed at. Order in, order out:
// relies on Tesseract preserving top-to-bottom line order (a role-ordered
// column OCRs that way).
export function parseKdaGroupLines(text: string): Kda[] {
  return text
    .split(/\n+/)
    .map((line) => parseKda(line))
    .filter((k): k is Kda => k !== null);
}
