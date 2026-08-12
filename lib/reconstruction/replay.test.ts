import { test } from "node:test";
import assert from "node:assert/strict";
import { runReplay, countEvents } from "./replay.ts";
import type { ReplayScenario } from "./replay.ts";
import { createEngine, ingest } from "./engine.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");
const a1 = asPlayerId("a1");
const b1 = asPlayerId("b1");

function scenario(name: string, ticks: ReplayScenario["ticks"]): ReplayScenario {
  return { name, gameId: G, teamAId: A, teamBId: B, ticks };
}

// ── Full game (spec §42) ───────────────────────────────────────────────────
test("replay: a full game reconstructs coherent state", () => {
  const r = runReplay(
    scenario("full-game", [
      { gameTimeSeconds: 0, timer: 5, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 0, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 0, assists: 0 } }] },
      { gameTimeSeconds: 60, timer: 65, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }], netWorth: { A: 5000, B: 4800 } },
      { gameTimeSeconds: 125, timer: 125, objectives: { turtle: { A: 1 } } },
      { gameTimeSeconds: 200, timer: 200, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 2, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 2, assists: 0 } }], netWorth: { A: 8000, B: 6000 } },
      { gameTimeSeconds: 500, timer: 500, objectives: { lord: { A: 1 } } },
      { gameTimeSeconds: 900, timer: 900, baseDestroyed: B },
    ])
  );
  assert.equal(r.reconciliation.coherent, true, r.reconciliation.conflicts.join(" | "));
  assert.equal(r.state.status, "finished");
  assert.equal(r.state.players["a1"].kills, 2);
  assert.equal(r.state.players["b1"].deaths, 2);
  assert.equal(r.state.teamKills["A"], 2);
  assert.equal(r.state.objectives.turtleTotal, 1);
  assert.equal(r.state.objectives.lordTotal, 1);
});

// ── Failure matrix (spec §34, §43) ─────────────────────────────────────────
test("failure: missing OCR keeps last confirmed", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 60, timer: 60 });
  ingest(e, { gameTimeSeconds: 61, timer: null }); // missing
  assert.equal(e.state.timerSeconds, 60);
});

test("failure: duplicated digit / garbled team-kill spike does not corrupt", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 60, timer: 60, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }] });
  ingest(e, { gameTimeSeconds: 65, timer: 65, teamKills: { A: 57 } }); // garbled
  assert.ok((e.state.teamKills["A"] ?? 0) <= 11, `team kills should not jump to 57, got ${e.state.teamKills["A"]}`);
  assert.equal(e.diagnostics.get("team_kills:A")!.status, "candidate");
});

test("failure: impossible K/D/A (deaths > enemy kills) rejected", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  // A has 0 kills; b1 read with 5 deaths is impossible.
  ingest(e, { gameTimeSeconds: 60, timer: 60, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 0, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 5, assists: 0 } }] });
  assert.equal(e.state.players["b1"].deaths, 0);
});

test("failure: net worth spike held as candidate, not applied", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 } });
  ingest(e, { gameTimeSeconds: 65, timer: 65, netWorth: { A: 90000 } }); // spike
  assert.ok(e.state.netWorth["A"] <= 13000, `got ${e.state.netWorth["A"]}`);
  assert.equal(e.diagnostics.get("net_worth:A")!.status, "candidate");
});

test("failure: timer rollback rejected (no reset)", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 300, timer: 300 });
  ingest(e, { gameTimeSeconds: 301, timer: 5 }); // rollback, no reset signals
  assert.equal(e.state.timerSeconds, 300);
});

test("failure: post-game OCR cannot reopen game", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 60, timer: 60, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }] });
  ingest(e, { gameTimeSeconds: 900, timer: 900, baseDestroyed: B });
  ingest(e, { gameTimeSeconds: 950, timer: 950, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 9, deaths: 0, assists: 0 } }], netWorth: { A: 50000 } });
  assert.equal(e.state.status, "finished");
  assert.equal(e.state.players["a1"].kills, 1, "post-game stat frozen");
});

test("failure: false reset (single timer glitch) does NOT reset", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 300, timer: 300 });
  const events = ingest(e, { gameTimeSeconds: 301, timer: 5, resetSignals: { timerDropped: true } });
  assert.equal(events.filter((x) => x.type === "GAME_RESET").length, 0);
  assert.equal(e.state.timerSeconds, 300);
});

test("real reset: two signals produce a GAME_RESET boundary", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 300, timer: 300 });
  const events = ingest(e, { gameTimeSeconds: 0, timer: 2, resetSignals: { timerDropped: true, scoreboardZeroed: true } });
  assert.equal(events.filter((x) => x.type === "GAME_RESET").length, 1);
});

test("failure: duplicate observation ticks are idempotent", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  const tick = { gameTimeSeconds: 60, timer: 60, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }] };
  ingest(e, tick);
  const v1 = e.state.players["a1"].kills;
  ingest(e, { ...tick, capturedAt: 999 }); // same game-time/values re-delivered
  assert.equal(e.state.players["a1"].kills, v1, "duplicate frame must not double-count");
});

// ── Post-finish lock (spec §19, §F) ────────────────────────────────────────
test("post-finish lock: every telemetry type frozen after GAME_FINISHED", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  // Build real state: a paired kill, net worth, a turtle.
  ingest(e, {
    gameTimeSeconds: 300, timer: 300,
    playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }],
    netWorth: { A: 5000 },
    objectives: { turtle: { A: 1 } },
  });
  const snap = {
    kills: e.state.players["a1"].kills,
    deaths: e.state.players["b1"].deaths,
    netWorth: e.state.netWorth["A"],
    turtles: e.state.objectives.turtleTotal,
    timer: e.state.timerSeconds,
  };
  ingest(e, { gameTimeSeconds: 900, baseDestroyed: B }); // FINISH (no new telemetry)
  // Post-finish OCR frames of every kind — all must be ignored.
  ingest(e, {
    gameTimeSeconds: 950, timer: 950,
    playerKda: [{ playerId: a1, teamId: A, kda: { kills: 9, deaths: 0, assists: 9 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 9, assists: 0 } }],
    netWorth: { A: 99999 },
    teamKills: { A: 50 },
    objectives: { turtle: { A: 4 }, lord: { A: 3 }, tower: { A: 9 } },
  });
  assert.equal(e.state.status, "finished");
  assert.equal(e.state.players["a1"].kills, snap.kills);
  assert.equal(e.state.players["b1"].deaths, snap.deaths);
  assert.equal(e.state.netWorth["A"], snap.netWorth);
  assert.equal(e.state.objectives.turtleTotal, snap.turtles);
  assert.equal(e.state.objectives.lordTotal, 0);
  assert.equal(e.state.timerSeconds, snap.timer);
});

// ── Replay protection (spec §G) ────────────────────────────────────────────
// LIVE → REPLAY (old scoreboard values leak) → LIVE. Even if a stale replay
// frame reaches the engine, its lower/older values can never overwrite the
// confirmed live state (monotonic + never-decreases guards).
test("replay protection: stale replay-frame values never overwrite confirmed", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  // LIVE at 10:00 — high values.
  ingest(e, {
    gameTimeSeconds: 600, timer: 600,
    playerKda: [{ playerId: a1, teamId: A, kda: { kills: 5, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 5, assists: 0 } }],
    netWorth: { A: 20000 },
  });
  assert.equal(e.state.players["a1"].kills, 5);
  // REPLAY frame shows the OLD scoreboard from 02:00 (kills 1, net worth 5000,
  // timer 120). A stale, lower frame — must be rejected wholesale.
  ingest(e, {
    gameTimeSeconds: 120, timer: 120,
    playerKda: [{ playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } }],
    netWorth: { A: 5000 },
  });
  assert.equal(e.state.players["a1"].kills, 5, "replay kills did not overwrite");
  assert.equal(e.state.players["b1"].deaths, 5, "replay deaths did not overwrite");
  assert.equal(e.state.netWorth["A"], 20000, "replay net worth did not overwrite");
  assert.equal(e.state.timerSeconds, 600, "replay timer did not roll back");
  // LIVE resumes at 10:05 with a real new kill → advances normally.
  ingest(e, {
    gameTimeSeconds: 605, timer: 605,
    playerKda: [{ playerId: a1, teamId: A, kda: { kills: 6, deaths: 0, assists: 0 } }, { playerId: b1, teamId: B, kda: { kills: 0, deaths: 6, assists: 0 } }],
  });
  assert.equal(e.state.players["a1"].kills, 6, "live resumes and advances");
});

test("objective: illegal turtle before 02:00 rejected end-to-end", () => {
  const r = runReplay(scenario("early-turtle", [{ gameTimeSeconds: 30, timer: 30, objectives: { turtle: { A: 1 } } }]));
  assert.equal(r.state.objectives.turtleTotal, 0);
  assert.equal(countEvents(r, "TURTLE_KILLED"), 0);
});
