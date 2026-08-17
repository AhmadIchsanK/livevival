import { test } from "node:test";
import assert from "node:assert/strict";
import { observeVision } from "./visionObserver.ts";
import type { VisionConfirmedContext } from "./visionObserver.ts";
import { asTeamId, asPlayerId } from "./types.ts";
import type { PlayerKda } from "./validators/kda.ts";

const A = asTeamId("A");
const B = asTeamId("B");

function ctx(overrides?: Partial<VisionConfirmedContext>): VisionConfirmedContext {
  return {
    confirmedKda: new Map<string, PlayerKda>(),
    confirmedNetWorth: {},
    teamOf: new Map<string, string>(),
    teamAId: A,
    teamBId: B,
    ...overrides,
  };
}

test("net worth: first reading confirms and grades", () => {
  const obs = observeVision({ netWorth: { A: 5000 } }, ctx(), { rawConfidence: 0.9 });
  assert.equal(obs.length, 1);
  assert.equal(obs[0].field, "net_worth");
  assert.equal(obs[0].status, "confirmed");
  assert.deepEqual(obs[0].normalizedValue, { kind: "net_worth", gold: 5000 });
  assert.ok(["MEDIUM", "HIGH"].includes(obs[0].band));
});

test("net worth: a decrease is rejected (never authoritative)", () => {
  const obs = observeVision({ netWorth: { A: 4000 } }, ctx({ confirmedNetWorth: { A: 5000 } }), { rawConfidence: 0.9 });
  assert.equal(obs[0].status, "rejected");
  assert.equal(obs[0].band, "LOW");
});

test("net worth: an implausible spike is a candidate, not confirmed", () => {
  const obs = observeVision({ netWorth: { A: 50000 } }, ctx({ confirmedNetWorth: { A: 5000 } }), { rawConfidence: 0.9 });
  assert.equal(obs[0].status, "candidate");
});

test("player KDA: a clean batch confirms both players", () => {
  const teamOf = new Map<string, string>([
    ["p1", "A"],
    ["p2", "B"],
  ]);
  const obs = observeVision(
    {
      players: [
        { playerId: asPlayerId("p1"), teamId: A, kills: 1, deaths: 0, assists: 0 },
        { playerId: asPlayerId("p2"), teamId: B, kills: 0, deaths: 1, assists: 0 },
      ],
    },
    ctx({ teamOf }),
    { rawConfidence: 0.85 }
  );
  assert.equal(obs.length, 2);
  for (const o of obs) {
    assert.equal(o.field, "player_kda");
    assert.equal(o.status, "confirmed");
  }
});

test("player KDA: impossible deaths (exceeding enemy kills) becomes candidate, never confirmed", () => {
  const teamOf = new Map<string, string>([
    ["p1", "A"],
    ["p2", "B"],
  ]);
  // p1 (team A) reads 9 deaths but team B has zero kills → impossible; the
  // validator holds it back, so the observation is a candidate, not confirmed.
  const obs = observeVision(
    {
      players: [
        { playerId: asPlayerId("p1"), teamId: A, kills: 0, deaths: 9, assists: 0 },
        { playerId: asPlayerId("p2"), teamId: B, kills: 0, deaths: 0, assists: 0 },
      ],
    },
    ctx({ teamOf }),
    { rawConfidence: 0.9 }
  );
  const p1 = obs.find((o) => o.playerId === "p1")!;
  assert.equal(p1.status, "candidate");
  assert.notEqual(p1.band, "HIGH"); // a held-back read is never HIGH
});

test("vision source with a single read is never HIGH (needs repetition)", () => {
  const obs = observeVision({ netWorth: { A: 5000 } }, ctx(), { rawConfidence: 1, repetition: 1 });
  assert.notEqual(obs[0].band, "HIGH");
});

test("empty detection yields no observations", () => {
  assert.equal(observeVision({}, ctx()).length, 0);
});
