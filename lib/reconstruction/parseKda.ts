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

// One region spanning all five KDA rows, split back into per-row readings.
//
// A scoreboard column OCRs as more than five clean lines: each player's row also
// carries a net worth ("3502"), a hero level ("81"), sometimes a spell timer —
// often on their own lines, sometimes wrapped oddly. Splitting strictly by line
// and requiring every line to be a KDA (the old behavior) broke the moment a net
// worth landed on its own line, because that line isn't "N/N/N" and the caller
// demanded exactly five KDA lines.
//
// Instead, scan the WHOLE blob for the strict KDA shape and collect every match
// in order. A bare number (net worth "3502", level "81") has no "/" separators so
// it can never match — it's skipped, never mistaken for a KDA. The trailing guard
// still rejects a net worth fused onto the third field ("0/0/4 3630" → 0/0/4).
// Order in, order out: Tesseract preserves top-to-bottom order for a role-ordered
// column, so the Nth triple found is the Nth player.
export function parseKdaGroupLines(text: string): Kda[] {
  const out: Kda[] = [];
  // Global scan for the same shape parseKda pins, on the raw text first then on a
  // glyph-normalized copy (recovering digits OCR'd as look-alike letters) — but
  // only add glyph-recovered rows if the raw scan came up short, so we never
  // double-count the same row read two different ways.
  const scan = (s: string): Kda[] => {
    const re = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g;
    const found: Kda[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      found.push({ kills: Number(m[1]), deaths: Number(m[2]), assists: Number(m[3]) });
    }
    return found;
  };
  const direct = scan(text);
  if (direct.length >= 5) return direct;
  const recovered = scan(text.replace(/[OoIlSBZ]/g, (c) => KDA_DIGIT_GLYPHS[c] ?? c));
  // Prefer whichever pass found more complete rows.
  return recovered.length > direct.length ? recovered : direct.length > 0 ? direct : out;
}
