import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTurtle, validateLord, validateTurret, allTurretKeys, turretKey } from "./objectives.ts";
import { validateNetWorth } from "./netWorth.ts";

// ── Turtle ──
test("turtle: rejected before 02:00", () => {
  assert.equal(validateTurtle(1, 0, { timerSeconds: 60, turtleTotal: 0, lastTurtleKillSeconds: null }).status, "rejected");
});
test("turtle: accepted at 02:00 within tolerance", () => {
  assert.equal(validateTurtle(1, 0, { timerSeconds: 117, turtleTotal: 0, lastTurtleKillSeconds: null }).status, "confirmed");
});
test("turtle: 2-min respawn enforced", () => {
  assert.equal(validateTurtle(2, 1, { timerSeconds: 180, turtleTotal: 1, lastTurtleKillSeconds: 120 }).status, "rejected");
  assert.equal(validateTurtle(2, 1, { timerSeconds: 240, turtleTotal: 1, lastTurtleKillSeconds: 120 }).status, "confirmed");
});
test("turtle: 06:00 cutoff blocks follow-up (kill at 06:30 → minute 6 → 360)", () => {
  assert.equal(validateTurtle(4, 3, { timerSeconds: 540, turtleTotal: 3, lastTurtleKillSeconds: 360 }).status, "rejected");
});
test("turtle: max 4 per game", () => {
  assert.equal(validateTurtle(5, 4, { timerSeconds: 300, turtleTotal: 4, lastTurtleKillSeconds: 240 }).status, "rejected");
});
test("turtle: late-game misread rejected", () => {
  assert.equal(validateTurtle(1, 0, { timerSeconds: 720, turtleTotal: 0, lastTurtleKillSeconds: null }).status, "rejected");
});

// ── Lord ──
test("lord: rejected before 08:00", () => {
  assert.equal(validateLord(1, 0, { timerSeconds: 400, lastLordKillSeconds: null }).status, "rejected");
});
test("lord: accepted at 08:00", () => {
  assert.equal(validateLord(1, 0, { timerSeconds: 480, lastLordKillSeconds: null }).status, "confirmed");
});
test("lord: 3-min respawn enforced", () => {
  assert.equal(validateLord(2, 1, { timerSeconds: 560, lastLordKillSeconds: 480 }).status, "rejected");
  assert.equal(validateLord(2, 1, { timerSeconds: 660, lastLordKillSeconds: 480 }).status, "confirmed");
});

// ── Turret ──
test("turret: monotonic, capped at 9", () => {
  assert.equal(validateTurret(10, 8).value, 9);
});
test("turret: jump beyond 3/tick held as candidate", () => {
  const r = validateTurret(7, 0);
  assert.equal(r.status, "candidate");
  assert.equal(r.value, 3);
});
test("turret: normal fall confirmed", () => {
  assert.equal(validateTurret(3, 1).status, "confirmed");
});
test("turret model: 9 keys top/mid/bot x T1/T2/T3", () => {
  const keys = allTurretKeys();
  assert.equal(keys.length, 9);
  assert.ok(keys.includes(turretKey("mid", 2)));
});

// ── Net worth ──
test("net worth: monotonic; spike held", () => {
  assert.equal(validateNetWorth(6000, 5000).status, "confirmed");
  assert.equal(validateNetWorth(5000, 5000).status, "confirmed");
  assert.equal(validateNetWorth(4000, 5000).status, "rejected");
  const spike = validateNetWorth(50000, 5000);
  assert.equal(spike.status, "candidate");
  assert.equal(spike.value, 13000);
  assert.equal(validateNetWorth(null, 5000).status, "missing");
});
