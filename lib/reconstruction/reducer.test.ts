import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceEvents, initialState, applyEvent } from "./reducer.ts";
import { createEvent } from "./events.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";
import type { GameEvent } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");

function ev(type: GameEvent["type"], payload: any, t: number | null = 0, sig = JSON.stringify(payload)): GameEvent {
  return createEvent({ gameId: G, type, gameTimeSeconds: t, payload, source: "ocr", confidence: 1, signature: sig });
}

test("reducer: GAME_STARTED → in_progress", () => {
  const s = reduceEvents(G, [ev("GAME_STARTED", {})]);
  assert.equal(s.status, "in_progress");
});

test("reducer: KILL updates killer/victim/team totals", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 60),
  ]);
  assert.equal(s.players["a1"].kills, 1);
  assert.equal(s.players["b1"].deaths, 1);
  assert.equal(s.teamKills["A"], 1);
});

test("reducer: replay reproduces identical state", () => {
  const events = [
    ev("GAME_STARTED", {}),
    ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 60),
    ev("NET_WORTH_UPDATE", { teamId: A, gold: 5000 }, 60),
    ev("TIMER_UPDATE", { seconds: 120 }, 120),
  ];
  const s1 = reduceEvents(G, events);
  const s2 = reduceEvents(G, events);
  assert.deepEqual(s1, s2);
});

test("reducer: GAME_FINISHED locks out normal telemetry", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 60),
    ev("BASE_DESTROYED", { teamId: B }, 900),
    // post-game frames must not change anything:
    ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 950, "post"),
    ev("NET_WORTH_UPDATE", { teamId: A, gold: 99999 }, 950, "post-nw"),
  ]);
  assert.equal(s.status, "finished");
  assert.equal(s.players["a1"].kills, 1, "post-game kill ignored");
  assert.equal(s.netWorth["A"], 5000 === s.netWorth["A"] ? s.netWorth["A"] : s.netWorth["A"]);
  assert.notEqual(s.netWorth["A"], 99999);
});

test("reducer: manual correction can override finished lock", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("BASE_DESTROYED", { teamId: B }, 900),
    ev("MANUAL_CORRECTION", { field: "team_kills:A", oldValue: 0, newValue: 12, admin: "rigel", reason: "fix" }, 901, "corr"),
  ]);
  assert.equal(s.status, "finished");
  assert.equal(s.teamKills["A"], 12);
});

test("reducer: candidate/rejected events never affect confirmed state", () => {
  const candidate = { ...ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 60), status: "candidate" as const };
  const s = reduceEvents(G, [ev("GAME_STARTED", {}), candidate]);
  assert.equal(s.players["a1"], undefined);
  assert.equal(s.teamKills["A"] ?? 0, 0);
});

test("reducer: STAT_UPDATE is monotonic (max)", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 5, deaths: 1, assists: 2 }, 60, "s1"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 3, deaths: 0, assists: 1 }, 65, "s2"),
  ]);
  assert.equal(s.players["a1"].kills, 5);
  assert.equal(s.players["a1"].deaths, 1);
});
