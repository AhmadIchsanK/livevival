import { test } from "node:test";
import assert from "node:assert/strict";
import { detectReset, NO_SIGNALS } from "./reset.ts";

test("reset: single timer drop is NOT a reset (false reset)", () => {
  const v = detectReset({ ...NO_SIGNALS, timerDropped: true });
  assert.equal(v.isReset, false);
});

test("reset: two inferred signals ARE a reset (real reset)", () => {
  const v = detectReset({ ...NO_SIGNALS, timerDropped: true, scoreboardZeroed: true });
  assert.equal(v.isReset, true);
  assert.ok(v.confidence >= 0.5);
});

test("reset: admin start is authoritative", () => {
  const v = detectReset({ ...NO_SIGNALS, adminStartedGame: true });
  assert.equal(v.isReset, true);
  assert.equal(v.confidence, 1);
});

test("reset: game id change is authoritative", () => {
  const v = detectReset({ ...NO_SIGNALS, gameIdChanged: true });
  assert.equal(v.isReset, true);
});

test("reset: no signals → no reset", () => {
  assert.equal(detectReset(NO_SIGNALS).isReset, false);
});
