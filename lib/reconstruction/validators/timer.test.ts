import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTimer } from "./timer.ts";

test("timer: first reading is confirmed", () => {
  const r = validateTimer(120, { confirmedSeconds: null });
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 120);
});

test("timer: monotonic increase confirmed", () => {
  const r = validateTimer(130, { confirmedSeconds: 120 });
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 130);
});

test("timer: unchanged keeps previous", () => {
  const r = validateTimer(120, { confirmedSeconds: 120 });
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 120);
});

test("timer: small decrease within tolerance keeps previous, not rejected", () => {
  const r = validateTimer(118, { confirmedSeconds: 120 });
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 120);
});

test("timer: decrease beyond tolerance is rejected (no reset here)", () => {
  const r = validateTimer(60, { confirmedSeconds: 300 });
  assert.equal(r.status, "rejected");
});

test("timer: missing reading keeps last confirmed", () => {
  const r = validateTimer(null, { confirmedSeconds: 300 });
  assert.equal(r.status, "missing");
});

test("timer: implausible forward jump rejected (e.g. 05:00 read as 50:00)", () => {
  const r = validateTimer(3000, { confirmedSeconds: 120 });
  assert.equal(r.status, "rejected");
});

test("timer: sparse-but-legitimate forward gap accepted", () => {
  const r = validateTimer(500, { confirmedSeconds: 200 });
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 500);
});
