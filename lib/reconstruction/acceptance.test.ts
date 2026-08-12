// Shadow-mode acceptance criteria (spec Phase 9) as explicit, named tests.
// These are the gate that must stay green before RECONSTRUCTION_PUBLIC_READS is
// ever switched on. Each maps to one bullet in the Phase 9 acceptance list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, ingest } from "./engine.ts";
import { reconcile } from "./reconcile.ts";
import { toPublicState } from "./snapshot.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

const A = asTeamId("A");
const B = asTeamId("B");
const a1 = asPlayerId("a1");
const b1 = asPlayerId("b1");

function eng(id = "g") {
  return createEngine({ gameId: asGameId(id), teamAId: A, teamBId: B });
}

test("ACCEPT: no impossible confirmed K/D/A (deaths never exceed enemy kills)", () => {
  const e = eng();
  ingest(e, { gameTimeSeconds: 60, timer: 60, playerKda: [
    { playerId: a1, teamId: A, kda: { kills: 0, deaths: 0, assists: 0 } },
    { playerId: b1, teamId: B, kda: { kills: 0, deaths: 8, assists: 0 } },
  ] });
  assert.ok(reconcile(e.state).coherent);
  assert.equal(e.state.players["b1"].deaths, 0);
});

test("ACCEPT: no illegal objective transitions (lord respawn < 3min rejected)", () => {
  const e = eng();
  ingest(e, { gameTimeSeconds: 500, timer: 500, objectives: { lord: { A: 1 } } });
  ingest(e, { gameTimeSeconds: 560, timer: 560, objectives: { lord: { A: 2 } } }); // 60s later
  assert.equal(e.state.objectives.lordTotal, 1);
});

test("ACCEPT: no cross-game contamination (separate engines, separate state)", () => {
  const g1 = eng("game1");
  const g2 = eng("game2");
  ingest(g1, { gameTimeSeconds: 60, timer: 60, teamKills: { A: 5 }, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 5, deaths: 0, assists: 0 } }] });
  ingest(g2, { gameTimeSeconds: 30, timer: 30 });
  assert.equal(g2.state.teamKills["A"] ?? 0, 0, "game2 must not see game1 kills");
  assert.equal(g2.state.players["a1"], undefined);
});

test("ACCEPT: no post-GAME_FINISHED mutations", () => {
  const e = eng();
  // a1's kill pairs with b1's death → confirmed kill (kills now require a victim).
  ingest(e, { gameTimeSeconds: 60, timer: 60, playerKda: [
    { playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } },
    { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } },
  ] });
  ingest(e, { gameTimeSeconds: 900, timer: 900, baseDestroyed: B });
  ingest(e, { gameTimeSeconds: 950, timer: 950, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 9, deaths: 0, assists: 0 } }], netWorth: { A: 99999 } });
  assert.equal(e.state.status, "finished");
  assert.equal(e.state.players["a1"].kills, 1);
  assert.equal(e.state.netWorth["A"] ?? 0, 0);
});

test("ACCEPT: no duplicate kill events (idempotent re-delivery)", () => {
  const e = eng();
  const tick = { gameTimeSeconds: 60, timer: 60, playerKda: [
    { playerId: a1, teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } },
    { playerId: b1, teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } },
  ] };
  ingest(e, tick);
  ingest(e, { ...tick, capturedAt: 12345 });
  assert.equal(e.state.teamKills["A"], 1);
  assert.equal(e.state.players["a1"].kills, 1);
});

test("ACCEPT: no timer rollback within a game", () => {
  const e = eng();
  ingest(e, { gameTimeSeconds: 300, timer: 300 });
  ingest(e, { gameTimeSeconds: 301, timer: 120 });
  assert.equal(e.state.timerSeconds, 300);
});

test("ACCEPT: no suspicious net-worth spike becomes confirmed", () => {
  const e = eng();
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 } });
  ingest(e, { gameTimeSeconds: 65, timer: 65, netWorth: { A: 99000 } });
  assert.ok((e.state.netWorth["A"] ?? 0) <= 13000);
});

test("ACCEPT: public state derives only from confirmed events (no raw OCR leak)", () => {
  const e = eng();
  // A rejected reading (garbled team kills) must not appear in public state.
  ingest(e, { gameTimeSeconds: 60, timer: 60, teamKills: { A: 57 } });
  const pub = toPublicState(e.state);
  assert.ok((pub.teamKills["A"] ?? 0) < 57);
  // public contract exposes no candidate/rejected structures
  assert.ok(!("candidates" in pub) && !("rejected" in pub));
});

test("ACCEPT: reconstruction stable during missing OCR (keeps last confirmed)", () => {
  const e = eng();
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 }, teamKills: { A: 3 }, playerKda: [{ playerId: a1, teamId: A, kda: { kills: 3, deaths: 0, assists: 0 } }] });
  const before = toPublicState(e.state);
  ingest(e, { gameTimeSeconds: 61, timer: null }); // fully missing tick
  const after = toPublicState(e.state);
  assert.equal(after.netWorth["A"].gold, before.netWorth["A"].gold);
  assert.equal(after.teamKills["A"], before.teamKills["A"]);
  assert.equal(after.timer.seconds, before.timer.seconds);
});
