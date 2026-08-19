import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PLAUSIBLE_TEAM_KILLS,
  normalizeTeamKillNumber,
  teamKillObservation,
} from "./teamKillObservation.ts";

// Team kills use EXACTLY the objectives discipline: digits-only normalization
// with a hard plausibility bound, plus a monotonic candidate decision. These
// tests pin that pure layer (the plausibility pace/jump gate and the manual
// cooldown live in the admin capture loop, asserted there).

test("normalize: strips non-digits, reads a clean count", () => {
  assert.equal(normalizeTeamKillNumber("12"), 12);
  assert.equal(normalizeTeamKillNumber(" 7 "), 7);
  assert.equal(normalizeTeamKillNumber("0"), 0);
});

test("normalize: blank / non-numeric → null (keep last confirmed)", () => {
  assert.equal(normalizeTeamKillNumber(""), null);
  assert.equal(normalizeTeamKillNumber("   "), null);
  assert.equal(normalizeTeamKillNumber("abc"), null);
});

test("normalize: 3+ digit blob (merged numbers / net worth) → null", () => {
  assert.equal(normalizeTeamKillNumber("511"), null);
  assert.equal(normalizeTeamKillNumber("47000"), null);
  assert.equal(normalizeTeamKillNumber("882"), null);
});

test("normalize: value past the absolute plausibility bound → null", () => {
  assert.equal(normalizeTeamKillNumber(String(MAX_PLAUSIBLE_TEAM_KILLS + 1)), null);
});

test("observation: first reading accepted", () => {
  const o = teamKillObservation({ side: "a", raw: "3", confirmed: null });
  assert.equal(o.normalized, 3);
  assert.equal(o.accepted, true);
});

test("observation: increase accepted", () => {
  const o = teamKillObservation({ side: "b", raw: "9", confirmed: 6 });
  assert.equal(o.accepted, true);
  assert.equal(o.normalized, 9);
});

test("observation: equal is unchanged (accepted, no-op)", () => {
  const o = teamKillObservation({ side: "a", raw: "6", confirmed: 6 });
  assert.equal(o.accepted, true);
  assert.equal(o.reason, "unchanged");
});

test("observation: below confirmed is suspicious, not overwritten", () => {
  const o = teamKillObservation({ side: "a", raw: "4", confirmed: 8 });
  assert.equal(o.accepted, false);
  assert.match(o.reason, /below confirmed 8/);
});

test("observation: blank keeps last confirmed", () => {
  const o = teamKillObservation({ side: "b", raw: "", confirmed: 5 });
  assert.equal(o.accepted, false);
  assert.equal(o.normalized, null);
});
