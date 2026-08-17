import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseField, fieldFusionPolicy, defaultTolerance } from "./fusion.ts";

// ── field policy (§29) ──────────────────────────────────────────────────────
test("policy: numeric telemetry is CV-primary, semantics AI-primary", () => {
  assert.equal(fieldFusionPolicy("net_worth"), "cv_primary");
  assert.equal(fieldFusionPolicy("game_timer"), "cv_primary");
  assert.equal(fieldFusionPolicy("player_kda"), "cv_primary");
  assert.equal(fieldFusionPolicy("objective_tower"), "cv_primary");
  assert.equal(fieldFusionPolicy("draft_phase"), "ai_primary");
  assert.equal(fieldFusionPolicy("kill_banner"), "ai_primary");
});

test("tolerance: net worth windowed, timer windowed, counts exact", () => {
  assert.equal(defaultTolerance("net_worth"), 1000);
  assert.equal(defaultTolerance("game_timer"), 3);
  assert.equal(defaultTolerance("player_kda"), 0);
});

// ── presence cases ──────────────────────────────────────────────────────────
test("none: no evidence → UNKNOWN, holds", () => {
  const r = fuseField({ field: "net_worth" });
  assert.equal(r.agreement, "none");
  assert.equal(r.value, null);
  assert.equal(r.band, "UNKNOWN");
});

test("single CV: value carried, not corroborated → at most MEDIUM", () => {
  const r = fuseField({ field: "net_worth", cv: { value: 5000, rawConfidence: 0.9 } });
  assert.equal(r.agreement, "single");
  assert.equal(r.value, 5000);
  assert.equal(r.source, "ocr");
  assert.notEqual(r.band, "HIGH");
});

test("single AI on an AI-primary field", () => {
  const r = fuseField({ field: "draft_phase", ai: { value: "DRAFT_PICK_BAN", rawConfidence: 0.8 } });
  assert.equal(r.agreement, "single");
  assert.equal(r.value, "DRAFT_PICK_BAN");
  assert.equal(r.source, "vision");
});

// ── agreement corroborates → HIGH, primary value carried ───────────────────
test("agree (net worth within tolerance) → corroborated HIGH, CV value", () => {
  const r = fuseField({ field: "net_worth", cv: { value: 5000, rawConfidence: 0.9 }, ai: { value: 5500, rawConfidence: 0.8 } });
  assert.equal(r.agreement, "agree");
  assert.equal(r.conflict, false);
  assert.equal(r.value, 5000); // CV primary
  assert.equal(r.source, "ocr");
  assert.equal(r.band, "HIGH");
});

test("agree on AI-primary field carries the AI value", () => {
  const r = fuseField({ field: "kill_banner", cv: { value: "SAVAGE", rawConfidence: 0.6 }, ai: { value: "savage!", rawConfidence: 0.9 } });
  assert.equal(r.agreement, "agree");
  assert.equal(r.value, "savage!"); // AI primary
  assert.equal(r.source, "vision");
});

// ── conflict: never average, hold, log ─────────────────────────────────────
test("conflict (net worth beyond tolerance) → hold, no averaging, logged", () => {
  const r = fuseField({ field: "net_worth", cv: { value: 5000, rawConfidence: 0.9 }, ai: { value: 9000, rawConfidence: 0.9 } });
  assert.equal(r.agreement, "conflict");
  assert.equal(r.conflict, true);
  assert.equal(r.value, null); // held — confirmed state preserved
  assert.equal(r.source, null);
  assert.notEqual(r.value, 7000); // explicitly NOT the average
  assert.match(r.reason, /disagree/);
});

test("exact-match fields: 1-apart counts conflict (tolerance 0)", () => {
  const r = fuseField({ field: "objective_tower", cv: { value: 3, rawConfidence: 0.9 }, ai: { value: 4, rawConfidence: 0.9 } });
  assert.equal(r.agreement, "conflict");
  assert.equal(r.value, null);
});

test("exact-match fields: identical counts agree", () => {
  const r = fuseField({ field: "objective_tower", cv: { value: 3, rawConfidence: 0.9 }, ai: { value: 3, rawConfidence: 0.9 } });
  assert.equal(r.agreement, "agree");
  assert.equal(r.value, 3);
});

test("timer within a couple seconds agrees", () => {
  const r = fuseField({ field: "game_timer", cv: { value: 600, rawConfidence: 0.9 }, ai: { value: 602, rawConfidence: 0.8 } });
  assert.equal(r.agreement, "agree");
  assert.equal(r.value, 600);
});
