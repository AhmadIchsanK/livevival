import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OBJECTIVE_SIDE_ORDER,
  objectiveNumField,
  objectiveNumFieldsForSide,
  parseObjectiveNumField,
  normalizeObjectiveNumber,
  objectiveObservation,
} from "./objectivesObservation.ts";

// The combined objectives tracker is internally SIX independent numeric OCR
// sub-regions (three per side). These tests pin the pure mapping + numeric
// normalization + per-region monotonic/candidate decision that the admin
// capture loop wires the crops into. The 13 calibration scenarios the spec
// calls for are labeled below; the few that are loop/engine-level (reset,
// replay/pause suspension) are asserted at the observation level where the
// pure layer can express them, with the loop-side guard noted.

// (1) three independent regions per side, in broadcast order
test("(1) three independent sub-regions per side, broadcast order", () => {
  assert.deepEqual(OBJECTIVE_SIDE_ORDER.left, ["turtle", "lord", "tower"]);
  assert.deepEqual(OBJECTIVE_SIDE_ORDER.right, ["tower", "lord", "turtle"]);
  assert.deepEqual(objectiveNumFieldsForSide("left").map((f) => f.field), [
    "objective_num_left_turtle",
    "objective_num_left_lord",
    "objective_num_left_tower",
  ]);
  assert.deepEqual(objectiveNumFieldsForSide("right").map((f) => f.field), [
    "objective_num_right_tower",
    "objective_num_right_lord",
    "objective_num_right_turtle",
  ]);
});

test("field round-trips through parse; foreign fields rejected", () => {
  assert.deepEqual(parseObjectiveNumField(objectiveNumField("left", "turtle")), { side: "left", type: "turtle" });
  assert.deepEqual(parseObjectiveNumField("objective_num_right_lord"), { side: "right", type: "lord" });
  assert.equal(parseObjectiveNumField("net_worth_left"), null);
  assert.equal(parseObjectiveNumField("objectives_group_left"), null, "old whole-strip field is not a sub-region");
});

// (2) numeric-only OCR — the crop holds only the number
test("(2) numeric-only normalization: digits only", () => {
  assert.equal(normalizeObjectiveNumber("2"), 2);
  assert.equal(normalizeObjectiveNumber(" 4 "), 4);
});

// (3) missing OCR keeps the last confirmed value
test("(3) missing OCR keeps last confirmed", () => {
  const o = objectiveObservation({ side: "left", type: "tower", raw: "", confirmed: 3 });
  assert.equal(o.accepted, false);
  assert.equal(o.normalized, null);
  assert.match(o.reason, /keep last confirmed/);
});

// (4) invalid OCR is held, not written
test("(4) invalid OCR is a held candidate, never overwrites", () => {
  const o = objectiveObservation({ side: "left", type: "tower", raw: "abc", confirmed: 3 });
  assert.equal(o.accepted, false);
  assert.equal(o.normalized, null);
});

// (5) turtle normalizes on its own
test("(5) turtle sub-region normalizes independently", () => {
  assert.equal(objectiveObservation({ side: "left", type: "turtle", raw: "1", confirmed: 0 }).normalized, 1);
  assert.equal(objectiveObservation({ side: "right", type: "turtle", raw: "2", confirmed: 1 }).accepted, true);
});

// (6) lord normalizes on its own
test("(6) lord sub-region normalizes independently", () => {
  assert.equal(objectiveObservation({ side: "left", type: "lord", raw: "1", confirmed: null }).accepted, true);
  assert.equal(objectiveObservation({ side: "right", type: "lord", raw: "0", confirmed: 0 }).reason, "unchanged");
});

// (7) tower normalizes on its own
test("(7) tower sub-region normalizes independently", () => {
  assert.equal(objectiveObservation({ side: "left", type: "tower", raw: "4", confirmed: 3 }).accepted, true);
  assert.equal(objectiveObservation({ side: "right", type: "tower", raw: "7", confirmed: 6 }).normalized, 7);
});

// (8) LEFT mapping is Turtle/Lord/Tower
test("(8) LEFT side maps positions to Turtle/Lord/Tower", () => {
  assert.deepEqual(objectiveNumFieldsForSide("left").map((f) => f.type), ["turtle", "lord", "tower"]);
});

// (9) RIGHT mapping is Tower/Lord/Turtle
test("(9) RIGHT side maps positions to Tower/Lord/Turtle", () => {
  assert.deepEqual(objectiveNumFieldsForSide("right").map((f) => f.type), ["tower", "lord", "turtle"]);
});

// (10) monotonic: increases accepted, decreases suspicious
test("(10) monotonic: 0→1→2→3 accepted, 3→2 held (needs reset)", () => {
  assert.equal(objectiveObservation({ side: "left", type: "turtle", raw: "1", confirmed: 0 }).accepted, true);
  assert.equal(objectiveObservation({ side: "left", type: "turtle", raw: "2", confirmed: 1 }).accepted, true);
  assert.equal(objectiveObservation({ side: "left", type: "turtle", raw: "3", confirmed: 2 }).accepted, true);
  const down = objectiveObservation({ side: "left", type: "turtle", raw: "2", confirmed: 3 });
  assert.equal(down.accepted, false);
  assert.match(down.reason, /below confirmed/);
});

// (11) OCR noise: stray glyphs stripped, implausibly large rejected
test("(11) OCR noise: icon/slash glyphs stripped, huge misread rejected", () => {
  assert.equal(normalizeObjectiveNumber("🐢2"), 2, "icon glyph stripped");
  assert.equal(normalizeObjectiveNumber("/ 3"), 3, "slash stripped");
  assert.equal(normalizeObjectiveNumber(""), null, "blank");
  assert.equal(normalizeObjectiveNumber("x"), null, "non-numeric");
  assert.equal(normalizeObjectiveNumber("999"), null, "implausibly large → rejected");
  // a noisy read that still contains a legal count is held as a candidate,
  // never silently applied, when it would drop below the confirmed value
  const noisy = objectiveObservation({ side: "left", type: "tower", raw: "8", confirmed: 3 });
  assert.equal(noisy.accepted, true, "8 is a legal increase over 3 at this layer");
  const noisyLower = objectiveObservation({ side: "left", type: "tower", raw: "1|", confirmed: 3 });
  assert.equal(noisyLower.accepted, false, "1 (below 3) is held, not written");
});

// (12) new-game reset: confirmed drops back to null → first reading accepted.
// The reset itself is driven by the (unchanged) engine/reducer; at the
// observation layer a post-reset region simply sees confirmed=null again.
test("(12) new-game reset: confirmed=null accepts a fresh first reading", () => {
  const o = objectiveObservation({ side: "left", type: "turtle", raw: "0", confirmed: null });
  assert.equal(o.accepted, true);
  assert.match(o.reason, /first reading/);
});

// (13) replay/pause suspension: the loop skips objective_num reads while a
// replay/pause overlay is on screen (suspendedNow() guard in captureTickBody),
// so no observation is produced and the last confirmed value is preserved.
// Asserted here as the equivalent observation-level invariant: a skipped tick
// is indistinguishable from a missing read, which keeps the last confirmed.
test("(13) replay/pause: a skipped/missing read keeps last confirmed", () => {
  const o = objectiveObservation({ side: "right", type: "lord", raw: "", confirmed: 2 });
  assert.equal(o.accepted, false);
  assert.equal(o.normalized, null);
  assert.match(o.reason, /keep last confirmed/);
});

test("unchanged reading is a no-op accept", () => {
  assert.equal(objectiveObservation({ side: "left", type: "tower", raw: "3", confirmed: 3 }).reason, "unchanged");
});
