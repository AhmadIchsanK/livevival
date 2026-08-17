import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceReliability,
  scoreEvidence,
  bandFromSignals,
  gradeEvidence,
  trackRepetition,
  stableKey,
  type EvidenceSignals,
  type RepetitionTracker,
} from "./confidence.ts";
import { createEngine, ingest } from "./engine.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

// ── source reliability ordering (spec §5/§29/§20) ──────────────────────────
test("source reliability: admin > ocr > vision > replay", () => {
  assert.ok(sourceReliability("admin") > sourceReliability("ocr"));
  assert.ok(sourceReliability("ocr") > sourceReliability("vision"));
  assert.ok(sourceReliability("vision") > sourceReliability("replay"));
  assert.equal(sourceReliability("admin"), 1.0);
});

// ── score is bounded and moves with each factor ────────────────────────────
const base: EvidenceSignals = {
  source: "ocr",
  rawConfidence: 0.9,
  repetition: 3,
  temporallyConsistent: true,
  crossFieldConsistent: true,
};

test("score: stays within 0..1", () => {
  for (const rep of [0, 1, 2, 3, 10]) {
    const s = scoreEvidence({ ...base, repetition: rep });
    assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
  }
});

test("score: a contradicted reading scores below a consistent one", () => {
  const consistent = scoreEvidence(base);
  const contradicted = scoreEvidence({ ...base, temporallyConsistent: false });
  assert.ok(contradicted < consistent);
});

test("score: repetition raises the score, saturating at 3", () => {
  const one = scoreEvidence({ ...base, repetition: 1 });
  const three = scoreEvidence({ ...base, repetition: 3 });
  const ten = scoreEvidence({ ...base, repetition: 10 });
  assert.ok(three > one);
  assert.equal(three, ten); // saturates
});

test("score: a more reliable source scores higher, all else equal", () => {
  assert.ok(scoreEvidence({ ...base, source: "admin" }) > scoreEvidence({ ...base, source: "replay" }));
});

// ── the four bands (spec §30) ──────────────────────────────────────────────
test("band UNKNOWN: no evidence (repetition 0)", () => {
  assert.equal(bandFromSignals({ ...base, repetition: 0 }), "UNKNOWN");
});

test("band HIGH: repeated valid reading", () => {
  assert.equal(bandFromSignals({ ...base, repetition: 3 }), "HIGH");
});

test("band MEDIUM: a single valid read is not yet HIGH", () => {
  const b = bandFromSignals({ source: "ocr", rawConfidence: 0.9, repetition: 1, temporallyConsistent: true, crossFieldConsistent: null });
  assert.equal(b, "MEDIUM");
});

test("band LOW: contradicted reading is weak regardless of source", () => {
  assert.equal(
    bandFromSignals({ source: "admin", rawConfidence: 1, repetition: 5, temporallyConsistent: false, crossFieldConsistent: null }),
    "LOW"
  );
  assert.equal(
    bandFromSignals({ source: "ocr", rawConfidence: 1, repetition: 5, temporallyConsistent: null, crossFieldConsistent: false }),
    "LOW"
  );
});

test("band LOW: weak single read from a low-trust source", () => {
  const b = bandFromSignals({ source: "replay", rawConfidence: 0.2, repetition: 1, temporallyConsistent: null, crossFieldConsistent: null });
  assert.equal(b, "LOW");
});

test("gradeEvidence returns both band and score", () => {
  const g = gradeEvidence(base);
  assert.equal(g.band, "HIGH");
  assert.ok(g.score > 0.5);
});

// ── repetition tracker ─────────────────────────────────────────────────────
test("stableKey: objects and primitives, null for empty", () => {
  assert.equal(stableKey(120), "120");
  assert.equal(stableKey({ a: 1 }), '{"a":1}');
  assert.equal(stableKey(null), null);
  assert.equal(stableKey(undefined), null);
});

test("trackRepetition: counts consecutive equal, resets on change and on null", () => {
  const t: RepetitionTracker = new Map();
  assert.equal(trackRepetition(t, "f", 5), 1);
  assert.equal(trackRepetition(t, "f", 5), 2);
  assert.equal(trackRepetition(t, "f", 5), 3);
  assert.equal(trackRepetition(t, "f", 6), 1); // changed value resets
  assert.equal(trackRepetition(t, "f", undefined), 0); // no reading resets
  assert.equal(trackRepetition(t, "f", 6), 1);
});

// ── engine integration: diagnostics carry a band, without changing state ────
function mkEngine() {
  return createEngine({ gameId: asGameId("g1"), teamAId: asTeamId("A"), teamBId: asTeamId("B") });
}

test("engine: a repeated confirmed net-worth reading grades HIGH", () => {
  const e = mkEngine();
  // Start the game + advance net worth across ticks. Net worth confirms and,
  // once the same reading repeats, the evidence band should reach HIGH.
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 }, source: "ocr", confidence: 0.95 });
  ingest(e, { gameTimeSeconds: 61, timer: 61, netWorth: { A: 5000 }, source: "ocr", confidence: 0.95 });
  const d = e.diagnostics.get("net_worth:A");
  assert.ok(d, "expected a net_worth:A diagnostic");
  assert.equal(d!.status, "confirmed");
  assert.equal(d!.band, "HIGH");
});

test("engine: a single fresh confirmed reading grades MEDIUM", () => {
  const e = mkEngine();
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 4200 }, source: "ocr", confidence: 0.9 });
  const d = e.diagnostics.get("net_worth:A");
  assert.equal(d!.band, "MEDIUM");
});

test("engine: a rejected reading grades LOW and confirmed state is unchanged", () => {
  const e = mkEngine();
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 }, source: "ocr", confidence: 0.9 });
  const before = e.state.netWorth["A"];
  // A decrease is rejected by the net-worth validator (never-decreases).
  ingest(e, { gameTimeSeconds: 61, timer: 61, netWorth: { A: 4000 }, source: "ocr", confidence: 0.9 });
  const d = e.diagnostics.get("net_worth:A");
  assert.equal(d!.status, "rejected");
  assert.equal(d!.band, "LOW");
  assert.equal(e.state.netWorth["A"], before, "rejected reading must not change confirmed net worth");
});

test("engine: player_kda diagnostic is graded too", () => {
  const e = mkEngine();
  ingest(e, {
    gameTimeSeconds: 60,
    timer: 60,
    playerKda: [{ playerId: asPlayerId("p1"), teamId: asTeamId("A"), kda: { kills: 1, deaths: 0, assists: 0 } }],
    source: "ocr",
    confidence: 0.8,
  });
  const d = e.diagnostics.get("player_kda:p1");
  assert.ok(d, "expected a player_kda:p1 diagnostic");
  assert.ok(d!.band === "MEDIUM" || d!.band === "HIGH" || d!.band === "LOW");
});
