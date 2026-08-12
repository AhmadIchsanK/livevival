import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicState, shadowCompare } from "./snapshot.ts";
import { reconcile } from "./reconcile.ts";
import { buildStateHealth } from "./health.ts";
import { reduceEvents } from "./reducer.ts";
import { createEvent } from "./events.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";
import type { GameEvent, ConfirmedState } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");

function ev(type: GameEvent["type"], payload: any, t = 0, sig = JSON.stringify(payload)): GameEvent {
  return createEvent({ gameId: G, type, gameTimeSeconds: t, payload, source: "ocr", confidence: 1, signature: sig });
}

function sampleState(): ConfirmedState {
  return reduceEvents(G, [
    ev("GAME_STARTED", {}),
    // Counters come from STAT_UPDATE (scoreboard OCR); a1 gets a kill, b1 a death.
    ev("STAT_UPDATE", { teamId: A, playerId: asPlayerId("a1"), kills: 1, deaths: 0, assists: 0 }, 60, "sa1"),
    ev("STAT_UPDATE", { teamId: B, playerId: asPlayerId("b1"), kills: 0, deaths: 1, assists: 0 }, 60, "sb1"),
    ev("NET_WORTH_UPDATE", { teamId: A, gold: 5500 }, 60),
    ev("TIMER_UPDATE", { seconds: 120 }, 120),
  ]);
}

test("toPublicState: exposes confirmed data with display formatting", () => {
  const pub = toPublicState(sampleState());
  assert.equal(pub.timer.display, "02:00");
  assert.equal(pub.netWorth["A"].display, "5.5K");
  assert.equal(pub.teamKills["A"], 1);
  assert.ok(pub.stateVersion > 0);
  // no candidate/rejected fields leak into the contract
  assert.ok(!("candidates" in pub));
});

test("shadowCompare: reports divergences only", () => {
  const s = sampleState();
  const noDiff = shadowCompare(
    { timerSeconds: 120, teamKills: { A: 1, B: 0 }, netWorth: { A: 5500 }, players: { a1: { kills: 1, deaths: 0, assists: 0 }, b1: { kills: 0, deaths: 1, assists: 0 } } },
    s
  );
  assert.equal(noDiff.length, 0, JSON.stringify(noDiff));
  const diff = shadowCompare(
    { timerSeconds: 120, teamKills: { A: 9 }, netWorth: { A: 5500 }, players: {} },
    s
  );
  assert.ok(diff.some((d) => d.field === "teamKills:A"));
});

test("reconcile: coherent state has no conflicts", () => {
  assert.equal(reconcile(sampleState()).coherent, true);
});

test("reconcile: detects impossible deaths vs enemy kills", () => {
  const s = sampleState();
  s.players["b1"].deaths = 9; // enemy (A) only has 1 kill
  const r = reconcile(s);
  assert.equal(r.coherent, false);
  assert.ok(r.conflicts.some((c) => c.includes("deaths")));
});

test("buildStateHealth: produces per-field rows + stale detection", () => {
  const s = sampleState();
  const health = buildStateHealth({
    state: s,
    observations: [
      { field: "game_timer", status: "confirmed", confidence: 0.9, lastObservedAt: Date.now() },
      { field: "net_worth", status: "candidate", candidateValue: 90000, confidence: 0.4, lastObservedAt: Date.now() - 60000, rejectionReason: "spike" },
    ],
    conflicts: [],
    now: Date.now(),
  });
  const timer = health.fields.find((f) => f.field === "game_timer")!;
  assert.equal(timer.status, "confirmed");
  const nw = health.fields.find((f) => f.field === "net_worth")!;
  assert.equal(nw.status, "candidate");
  assert.ok(nw.staleMs && nw.staleMs > 0, "60s-old reading flagged stale");
});
