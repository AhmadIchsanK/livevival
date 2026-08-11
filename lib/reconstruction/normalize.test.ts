import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTimer,
  formatTimer,
  normalizeKda,
  normalizeKdaGroup,
  normalizeNetWorth,
  formatNetWorth,
  normalizeCount,
  normalizeObjectivesGroup,
  normalizeConfidence,
} from "./normalize.ts";

test("timer: MM:SS parsed to seconds, ':' mandatory, SS 00-59", () => {
  assert.deepEqual(normalizeTimer("02:35"), { kind: "timer", seconds: 155 });
  assert.deepEqual(normalizeTimer("12:47"), { kind: "timer", seconds: 767 });
  assert.deepEqual(normalizeTimer("Timer 02:35 left"), { kind: "timer", seconds: 155 });
  assert.equal(normalizeTimer("0235"), null, "no colon → rejected");
  assert.equal(normalizeTimer("02:75"), null, "SS>=60 → rejected");
});

test("timer: format round-trips", () => {
  assert.equal(formatTimer(155), "02:35");
  assert.equal(formatTimer(767), "12:47");
  assert.equal(formatTimer(5), "00:05");
});

test("kda: strict digits + '/' only", () => {
  assert.deepEqual(normalizeKda("5/2/8"), { kind: "kda", kills: 5, deaths: 2, assists: 8 });
  assert.deepEqual(normalizeKda("0/0/0"), { kind: "kda", kills: 0, deaths: 0, assists: 0 });
  assert.deepEqual(normalizeKda("Kairi 5/2/8"), { kind: "kda", kills: 5, deaths: 2, assists: 8 });
  assert.equal(normalizeKda("5-2-8"), null, "dash separator rejected");
  assert.equal(normalizeKda("528"), null, "no separators rejected");
});

test("kda group: only strict N/N/N lines survive", () => {
  const rows = normalizeKdaGroup("5/2/8\ncooldown 12\n0/1/3\ngarbled\n7/7/7");
  assert.deepEqual(rows.map((r) => r.kills), [5, 0, 7]);
});

test("net worth: spec §5 OCR→internal table", () => {
  assert.deepEqual(normalizeNetWorth("55"), { kind: "net_worth", gold: 5500 });
  assert.deepEqual(normalizeNetWorth("127"), { kind: "net_worth", gold: 12700 });
  assert.deepEqual(normalizeNetWorth("341"), { kind: "net_worth", gold: 34100 });
  assert.deepEqual(normalizeNetWorth("34.1"), { kind: "net_worth", gold: 34100 });
  assert.deepEqual(normalizeNetWorth("34.1K"), { kind: "net_worth", gold: 34100 });
  assert.equal(normalizeNetWorth("5"), null, "single digit noise rejected");
  assert.equal(normalizeNetWorth("abc"), null);
});

test("net worth: display format is xx.xK", () => {
  assert.equal(formatNetWorth(5500), "5.5K");
  assert.equal(formatNetWorth(12700), "12.7K");
  assert.equal(formatNetWorth(34100), "34.1K");
});

test("count: non-negative integer, bounded", () => {
  assert.deepEqual(normalizeCount("11"), { kind: "count", count: 11 });
  assert.deepEqual(normalizeCount("k 3 x"), { kind: "count", count: 3 });
  assert.equal(normalizeCount(""), null);
  assert.equal(normalizeCount("100000", 999), null, "over bound rejected");
});

test("objectives group: exactly 3 runs or null", () => {
  assert.deepEqual(normalizeObjectivesGroup("2 1 3"), [2, 1, 3]);
  assert.equal(normalizeObjectivesGroup("2 1"), null, "partial read rejected");
  assert.equal(normalizeObjectivesGroup("2 1 3 4"), null);
});

test("confidence: normalized to 0..1", () => {
  assert.equal(normalizeConfidence(85), 0.85);
  assert.equal(normalizeConfidence(0.85), 0.85);
  assert.equal(normalizeConfidence(null), null);
  assert.equal(normalizeConfidence(120), 1);
});
