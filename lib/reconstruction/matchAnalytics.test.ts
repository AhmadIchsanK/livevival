// Tests for lib/matchAnalytics (kept under the reconstruction test glob so
// `npm test` picks it up). Imports across the lib/ boundary with an extension.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  netWorthDiffSeries,
  winProbabilityTeamA,
  roleWeights,
  computeMvpSvp,
} from "../matchAnalytics.ts";

test("netWorthDiffSeries: one point per minute (latest wins), sorted, diff = A-B", () => {
  const s = netWorthDiffSeries([
    { minute_mark: 0, team_a_gold: 5000, team_b_gold: 5000 },
    { minute_mark: 2, team_a_gold: 8000, team_b_gold: 7000 },
    { minute_mark: 2, team_a_gold: 8200, team_b_gold: 7100 }, // later reading same minute
    { minute_mark: 1, team_a_gold: 6000, team_b_gold: 6000 },
  ]);
  assert.deepEqual(s.map((p) => p.minute), [0, 1, 2]);
  assert.equal(s[2].teamA, 8200, "latest minute-2 reading kept");
  assert.equal(s[2].diff, 1100);
});

test("winProbability: even → ~50%, big gold lead → high, clamped", () => {
  assert.ok(Math.abs(winProbabilityTeamA({ teamAGold: 10000, teamBGold: 10000, teamAKills: 3, teamBKills: 3 }) - 0.5) < 1e-9);
  assert.ok(winProbabilityTeamA({ teamAGold: 40000, teamBGold: 20000, teamAKills: 20, teamBKills: 2 }) > 0.9);
  assert.ok(winProbabilityTeamA({ teamAGold: 20000, teamBGold: 40000, teamAKills: 2, teamBKills: 20 }) < 0.1);
  // never a false certainty
  const p = winProbabilityTeamA({ teamAGold: 999999, teamBGold: 0, teamAKills: 99, teamBKills: 0 });
  assert.ok(p <= 0.98 && p >= 0.02);
});

test("roleWeights: roamer favors assists, gold laner favors kills", () => {
  assert.ok(roleWeights("Roamer").assist > roleWeights("Gold Laner").assist);
  assert.ok(roleWeights("Gold Laner").kill > roleWeights("Roamer").kill);
});

test("MVP/SVP: role fairness lets an assist-heavy roamer win over a farmed kill role", () => {
  const players = [
    { id: "gold", teamId: "A", role: "Gold Laner", kills: 6, deaths: 4, assists: 2 },
    { id: "roam", teamId: "A", role: "Roamer", kills: 1, deaths: 2, assists: 14 },
    { id: "enemy", teamId: "B", role: "Jungler", kills: 3, deaths: 5, assists: 3 },
  ];
  const r = computeMvpSvp(players);
  assert.equal(r.mvpId, "roam", "high-participation roamer wins MVP fairly");
  assert.equal(r.svpId, "enemy", "SVP is the standout on the other team");
});

test("MVP/SVP: empty input is null", () => {
  const r = computeMvpSvp([]);
  assert.equal(r.mvpId, null);
  assert.equal(r.svpId, null);
});
