import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKda, parseKdaGroupLines } from "./parseKda.ts";

test("parseKda: plain N/N/N and spaced slashes", () => {
  assert.deepEqual(parseKda("2/0/5"), { kills: 2, deaths: 0, assists: 5 });
  assert.deepEqual(parseKda("12 / 3 / 15"), { kills: 12, deaths: 3, assists: 15 });
  assert.deepEqual(parseKda("Ling 6/1/9"), { kills: 6, deaths: 1, assists: 9 }, "hero name prefix ignored");
});

test("parseKda: net worth on the same row does not bleed into assists", () => {
  assert.deepEqual(parseKda("0/0/0 2956"), { kills: 0, deaths: 0, assists: 0 });
  assert.deepEqual(parseKda("2956 0/0/0"), { kills: 0, deaths: 0, assists: 0 }, "net worth before KDA");
  // A run fused directly onto the third field (no separator) is rejected, not misread.
  assert.equal(parseKda("10/2/34567"), null);
});

test("parseKda: recovers digits OCR'd as look-alike letters", () => {
  assert.deepEqual(parseKda("O/O/O"), { kills: 0, deaths: 0, assists: 0 }, "O→0");
  assert.deepEqual(parseKda("lO/2/3"), { kills: 10, deaths: 2, assists: 3 }, "l→1, O→0 (fully-lettered field)");
  assert.deepEqual(parseKda("S/1/B"), { kills: 5, deaths: 1, assists: 8 }, "S→5, B→8");
  assert.deepEqual(parseKda("1/Z/4"), { kills: 1, deaths: 2, assists: 4 }, "Z→2");
});

test("parseKda: letters can't fabricate a KDA (no slashes → no match)", () => {
  assert.equal(parseKda("SOS"), null, "no slashes present");
  assert.equal(parseKda("Bane"), null);
  assert.equal(parseKda("net worth 12500"), null);
});

test("parseKdaGroupLines: splits a 5-row region, drops garbled rows", () => {
  const text = "Kairi 6/1/9\ngarbled row\nSanz 3/2/7\n\nBennyqt O/4/2";
  assert.deepEqual(parseKdaGroupLines(text), [
    { kills: 6, deaths: 1, assists: 9 },
    { kills: 3, deaths: 2, assists: 7 },
    { kills: 0, deaths: 4, assists: 2 },
  ]);
});
