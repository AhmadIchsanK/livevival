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

test("reducer: STAT_UPDATE sets counters; team kills = summed player kills", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 1, deaths: 0, assists: 0 }, 60, "s1"),
    ev("STAT_UPDATE", { teamId: B, playerId: asPlayerId("b1"), kills: 0, deaths: 1, assists: 0 }, 60, "s2"),
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
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 1, deaths: 0, assists: 0 }, 60, "s1"),
    ev("NET_WORTH_UPDATE", { teamId: A, gold: 5000 }, 60),
    ev("BASE_DESTROYED", { teamId: B }, 900),
    // post-game frames must not change anything:
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 9, deaths: 0, assists: 0 }, 950, "post"),
    ev("NET_WORTH_UPDATE", { teamId: A, gold: 99999 }, 950, "post-nw"),
  ]);
  assert.equal(s.status, "finished");
  assert.equal(s.players["a1"].kills, 1, "post-game stat ignored");
  assert.equal(s.netWorth["A"], 5000);
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

// Player counters auto-update from the scoreboard OCR via STAT_UPDATE
// (monotonic max), and team kills follow the summed player kills.
test("reducer: STAT_UPDATE auto-updates kills/deaths/assists (monotonic max)", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 5, deaths: 1, assists: 0 }, 60, "s1"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 3, deaths: 0, assists: 0 }, 65, "s2"),
  ]);
  assert.equal(s.players["a1"].kills, 5, "never decreases");
  assert.equal(s.players["a1"].deaths, 1);
});

test("reducer: KILL is a moment marker only — counters come from STAT_UPDATE", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("KILL", { killerTeamId: A, victimTeamId: B, killerPlayerId: asPlayerId("a1"), victimPlayerId: asPlayerId("b1") }, 60, "k1"),
  ]);
  assert.equal(s.players["a1"]?.kills ?? 0, 0, "a KILL alone does not move counters");
  assert.equal(s.teamKills["A"] ?? 0, 0);
  assert.equal(s.timeline.length, 2, "GAME_STARTED + KILL both on the timeline (moment feed)");
});

// Regression for real live game 997bb2e6: a player's assists OCR'd as 80 while
// the team had 12 kills. Assists can never exceed the team's total kills.
test("reducer: assists cannot exceed team kills (live 80-assist bug)", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 2, deaths: 0, assists: 0 }, 60, "s1"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a2"), kills: 4, deaths: 0, assists: 0 }, 60, "s2"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a3"), kills: 0, deaths: 0, assists: 0 }, 60, "s3"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a4"), kills: 2, deaths: 0, assists: 0 }, 60, "s4"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a5"), kills: 4, deaths: 0, assists: 0 }, 60, "s5"),
    // a3's assists mis-read as 80 — clamp to the 12 team kills.
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a3"), kills: 0, deaths: 0, assists: 80 }, 514, "s6"),
  ]);
  assert.equal(s.teamKills["A"], 12);
  assert.equal(s.players["a3"].assists, 12, "80 assists clamped to the 12 team kills");
});

test("reducer: a legitimate assist within team kills is untouched", () => {
  const s = reduceEvents(G, [
    ev("GAME_STARTED", {}),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 4, deaths: 0, assists: 0 }, 60, "s1"),
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a2"), kills: 0, deaths: 0, assists: 2 }, 61, "s2"),
  ]);
  assert.equal(s.teamKills["A"], 4);
  assert.equal(s.players["a2"].assists, 2, "2 assists ≤ 4 team kills stays");
});
