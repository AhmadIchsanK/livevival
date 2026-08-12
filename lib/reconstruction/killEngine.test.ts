import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructKills } from "./killEngine.ts";
import { reduceEvents } from "./reducer.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");

test("kill engine: pairs a kill delta with an enemy death delta (killer+victim)", () => {
  const { events, pending } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 1, dDeaths: 0, dAssists: 0 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 },
    ],
    source: "ocr",
    confidence: 0.9,
  });
  assert.equal(events.length, 1);
  const p = events[0].payload as any;
  assert.equal(p.killerPlayerId, "a1");
  assert.equal(p.victimPlayerId, "b1");
  assert.deepEqual(pending.killsAwaitingVictim, {});
  assert.deepEqual(pending.deathsAwaitingKiller, {});
});

test("kill engine: team totals reconcile after reduce (A kills == B deaths)", () => {
  const { events } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 2, dDeaths: 1, dAssists: 0 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 1, dDeaths: 2, dAssists: 0 },
    ],
    source: "ocr",
    confidence: 0.9,
  });
  const s = reduceEvents(G, events);
  assert.equal(s.teamKills["A"], 2);
  assert.equal(s.teamKills["B"], 1);
  assert.equal(s.players["a1"].kills, 2);
  assert.equal(s.players["b1"].deaths, 2);
  // Conservation: A kills == B deaths, B kills == A deaths.
  assert.equal(s.players["a1"].deaths, 1);
  assert.equal(s.players["b1"].kills, 1);
});

test("kill engine: a kill with NO victim delta is held pending, never emitted null", () => {
  const { events, pending } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    // a1 got a kill, but no enemy death observed this window.
    playerDeltas: [{ playerId: asPlayerId("a1"), teamId: A, dKills: 1, dDeaths: 0, dAssists: 0 }],
    source: "ocr",
    confidence: 0.9,
  });
  assert.equal(events.length, 0, "no complete kill can be formed");
  assert.equal(pending.killsAwaitingVictim["A"], 1);
  const s = reduceEvents(G, events);
  assert.equal(s.teamKills["A"] ?? 0, 0, "team total is NOT fabricated from an unpaired kill");
});

test("kill engine: a death with NO enemy kill is held pending (conservation)", () => {
  const { events, pending } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    // b1 died, but no team A kill observed this window → cannot confirm.
    playerDeltas: [{ playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 }],
    source: "ocr",
    confidence: 0.9,
  });
  assert.equal(events.length, 0);
  assert.equal(pending.deathsAwaitingKiller["B"], 1);
  const s = reduceEvents(G, events);
  assert.equal(s.players["b1"]?.deaths ?? 0, 0, "death not committed without a kill to explain it");
});

test("kill engine: surplus kills over deaths pair the min and hold the rest", () => {
  const { events, pending } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 3, dDeaths: 0, dAssists: 0 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 },
    ],
    source: "ocr",
    confidence: 0.9,
  });
  assert.equal(events.length, 1, "only one death to pair against three kills");
  assert.equal(pending.killsAwaitingVictim["A"], 2);
});

test("kill engine: killer is never listed in their own assists", () => {
  const { events } = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 1, dDeaths: 0, dAssists: 1 },
      { playerId: asPlayerId("a2"), teamId: A, dKills: 0, dDeaths: 0, dAssists: 1 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 },
    ],
    source: "ocr",
    confidence: 0.9,
  });
  const p = events[0].payload as any;
  assert.ok(!p.assistPlayerIds.includes("a1"), "killer excluded from own assist list");
  assert.ok(p.assistPlayerIds.includes("a2"));
});

test("kill engine: identical window dedups (idempotent)", () => {
  const input = {
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 1, dDeaths: 0, dAssists: 0 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 },
    ],
    source: "ocr" as const,
    confidence: 0.9,
  };
  const e1 = reconstructKills(input);
  const e2 = reconstructKills(input);
  assert.equal(e1.events[0].eventId, e2.events[0].eventId, "same window → same event id");
});
