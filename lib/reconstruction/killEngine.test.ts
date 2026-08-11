import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructKills } from "./killEngine.ts";
import { reduceEvents } from "./reducer.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");

test("kill engine: reconstructs a single kill with killer+victim", () => {
  const events = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    teamKillDelta: { A: 1, B: 0 },
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
});

test("kill engine: team totals reconcile after reduce", () => {
  const events = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    teamKillDelta: { A: 2, B: 1 },
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
});

test("kill engine: uncertain identity leaves player null but keeps team total", () => {
  const events = reconstructKills({
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    teamKillDelta: { A: 1, B: 0 },
    playerDeltas: [], // no per-player deltas available
    source: "vision",
    confidence: 0.5,
  });
  assert.equal(events.length, 1);
  const p = events[0].payload as any;
  assert.equal(p.killerPlayerId, null);
  const s = reduceEvents(G, events);
  assert.equal(s.teamKills["A"], 1);
});

test("kill engine: identical window dedups (idempotent)", () => {
  const input = {
    gameId: G,
    gameTimeSeconds: 120,
    teamAId: A,
    teamBId: B,
    teamKillDelta: { A: 1, B: 0 },
    playerDeltas: [
      { playerId: asPlayerId("a1"), teamId: A, dKills: 1, dDeaths: 0, dAssists: 0 },
      { playerId: asPlayerId("b1"), teamId: B, dKills: 0, dDeaths: 1, dAssists: 0 },
    ],
    source: "ocr" as const,
    confidence: 0.9,
  };
  const e1 = reconstructKills(input);
  const e2 = reconstructKills(input);
  assert.equal(e1[0].eventId, e2[0].eventId, "same window → same event id");
});
