// Regression tests from the FIRST live shadow run (game bca5ba0c, ONIC vs
// Falcons, 2026-08-12). The live persisted reconstruction exposed one real
// reconstruction-side bug; this pins the fix. Everything else the live run
// verified (idempotency, monotonic timer, monotonic net worth, legal
// objectives, no cross-game contamination) is covered by existing suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, ingest } from "./engine.ts";
import { reconcile } from "./reconcile.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";

const A = asTeamId("A");
const B = asTeamId("B");

// BUG (live): the team-kills aggregate tracker minted one orphan KILL per
// unattributed increment — with null killer AND null victim — inflating Team A
// confirmed team kills to 27 while its five players summed to 19 (8 fabricated
// kills). Confirmed team kills must equal the summed player kills.
test("live-regression: team-kills tracker ahead of players does NOT fabricate kills", () => {
  const e = createEngine({ gameId: asGameId("live1"), teamAId: A, teamBId: B });
  const players = [
    asPlayerId("a1"), asPlayerId("a2"), asPlayerId("a3"), asPlayerId("a4"), asPlayerId("a5"),
  ];
  // Players accumulate 19 kills between them (2+8+0+2+7), like the live game.
  // The enemy team's deaths are observed too (19 total), so every kill pairs
  // into a complete, attributed KILL — team kills = 19 by attribution.
  ingest(e, {
    gameTimeSeconds: 600, timer: 600,
    playerKda: [
      { playerId: players[0], teamId: A, kda: { kills: 2, deaths: 0, assists: 0 } },
      { playerId: players[1], teamId: A, kda: { kills: 8, deaths: 0, assists: 0 } },
      { playerId: players[2], teamId: A, kda: { kills: 0, deaths: 0, assists: 0 } },
      { playerId: players[3], teamId: A, kda: { kills: 2, deaths: 0, assists: 0 } },
      { playerId: players[4], teamId: A, kda: { kills: 7, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("b1"), teamId: B, kda: { kills: 0, deaths: 4, assists: 0 } },
      { playerId: asPlayerId("b2"), teamId: B, kda: { kills: 0, deaths: 4, assists: 0 } },
      { playerId: asPlayerId("b3"), teamId: B, kda: { kills: 0, deaths: 4, assists: 0 } },
      { playerId: asPlayerId("b4"), teamId: B, kda: { kills: 0, deaths: 4, assists: 0 } },
      { playerId: asPlayerId("b5"), teamId: B, kda: { kills: 0, deaths: 3, assists: 0 } },
    ],
    // team-kills OCR reads 27 — ahead of the 19 attributed.
    teamKills: { A: 27 },
  });
  const summed = [2, 8, 0, 2, 7].reduce((s, x) => s + x, 0);
  assert.equal(summed, 19);
  assert.equal(e.state.teamKills["A"], 19, "confirmed team kills must equal player sum, not the 27 reading");
  // and the divergence is surfaced (candidate) rather than silently committed.
  assert.equal(e.diagnostics.get("team_kills:A")!.status, "candidate");
});

// BUG (live G1, 997bb2e6): team A confirmed 12 kills but team B accumulated 18
// confirmed deaths — raw OCR deaths were applied independently of kills. Deaths
// now derive only from complete KILL events, so team B deaths can never exceed
// team A kills. The 6 excess OCR deaths are held pending, never confirmed.
test("live-regression: OCR deaths (18) cannot exceed enemy kills (12) — G1 conservation", () => {
  const e = createEngine({ gameId: asGameId("g1-cons"), teamAId: A, teamBId: B });
  ingest(e, {
    gameTimeSeconds: 600, timer: 600,
    playerKda: [
      // Team A: 12 kills total.
      { playerId: asPlayerId("a1"), teamId: A, kda: { kills: 2, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("a2"), teamId: A, kda: { kills: 4, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("a3"), teamId: A, kda: { kills: 0, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("a4"), teamId: A, kda: { kills: 2, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("a5"), teamId: A, kda: { kills: 4, deaths: 0, assists: 0 } },
      // Team B: OCR reads 18 deaths total — impossible against 12 enemy kills.
      { playerId: asPlayerId("b1"), teamId: B, kda: { kills: 0, deaths: 1, assists: 0 } },
      { playerId: asPlayerId("b2"), teamId: B, kda: { kills: 0, deaths: 3, assists: 0 } },
      { playerId: asPlayerId("b3"), teamId: B, kda: { kills: 0, deaths: 5, assists: 0 } },
      { playerId: asPlayerId("b4"), teamId: B, kda: { kills: 0, deaths: 5, assists: 0 } },
      { playerId: asPlayerId("b5"), teamId: B, kda: { kills: 0, deaths: 4, assists: 0 } },
    ],
  });
  const teamAKills = e.state.teamKills["A"];
  const teamBDeaths = Object.values(e.state.players).filter((p) => p.teamId === "B").reduce((s, p) => s + p.deaths, 0);
  assert.equal(teamAKills, 12);
  assert.equal(teamBDeaths, 12, "confirmed deaths pinned to enemy kills, never the 18 OCR read");
  assert.ok(reconcile(e.state).coherent, "A kills == B deaths");
});

test("live-regression: reconcile flags fabricated (over-sum) team kills", () => {
  // Build a state where team kills exceed player attribution and assert
  // reconcile now catches it (previously it only caught under-sum).
  const e = createEngine({ gameId: asGameId("live2"), teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 600, timer: 600, playerKda: [{ playerId: asPlayerId("a1"), teamId: A, kda: { kills: 5, deaths: 0, assists: 0 } }] });
  // hand-corrupt to simulate a regression, then reconcile.
  e.state.teamKills["A"] = 9;
  const r = reconcile(e.state);
  assert.equal(r.coherent, false);
  assert.ok(r.conflicts.some((c) => c.includes("unattributed")));
});

test("live-regression: with attribution, team kills equal player sum exactly (coherent)", () => {
  const e = createEngine({ gameId: asGameId("live3"), teamAId: A, teamBId: B });
  ingest(e, {
    gameTimeSeconds: 600, timer: 600,
    playerKda: [
      { playerId: asPlayerId("a1"), teamId: A, kda: { kills: 3, deaths: 0, assists: 0 } },
      { playerId: asPlayerId("b1"), teamId: B, kda: { kills: 0, deaths: 3, assists: 0 } },
    ],
    teamKills: { A: 3 },
  });
  assert.equal(e.state.teamKills["A"], 3);
  // A kills (3) == B deaths (3): fully coherent.
  assert.equal(reconcile(e.state).coherent, true);
});
