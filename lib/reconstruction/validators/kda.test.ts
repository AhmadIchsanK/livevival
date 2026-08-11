import { test } from "node:test";
import assert from "node:assert/strict";
import { validateKdaBatch, validateTeamKills } from "./kda.ts";
import type { PlayerKdaReading, KdaContext } from "./kda.ts";
import { asPlayerId, asTeamId } from "../types.ts";

const A = asTeamId("teamA");
const B = asTeamId("teamB");

function ctx(confirmed: Record<string, [number, number, number]> = {}): KdaContext {
  const teamOf = new Map<string, string>([
    ["a1", "teamA"], ["a2", "teamA"], ["b1", "teamB"], ["b2", "teamB"],
  ]);
  const conf = new Map(
    Object.entries(confirmed).map(([k, [x, y, z]]) => [k, { kills: x, deaths: y, assists: z }])
  );
  return { confirmed: conf, teamOf, teamAId: A, teamBId: B };
}

function reading(pid: string, teamId: string, k: number, d: number, a: number): PlayerKdaReading {
  return { playerId: asPlayerId(pid), teamId: asTeamId(teamId), reading: { kills: k, deaths: d, assists: a } };
}

test("kda: coherent tick — A kills == B deaths", () => {
  // A players get 2 kills total; B players die 2 total.
  const res = validateKdaBatch(
    [reading("a1", "teamA", 2, 0, 1), reading("b1", "teamB", 0, 2, 0)],
    ctx()
  );
  assert.equal(res.reconciliation.coherent, true, res.reconciliation.conflicts.join());
  assert.equal(res.confirmedValues.get("a1")!.kills, 2);
});

test("kda: never-decreases clamps a lower read", () => {
  const res = validateKdaBatch([reading("a1", "teamA", 1, 0, 0)], ctx({ a1: [5, 0, 0] }));
  assert.equal(res.confirmedValues.get("a1")!.kills, 5);
  assert.equal(res.decisions[0].result.status, "candidate");
});

test("kda: per-tick spike ceiling holds a garbled jump", () => {
  // 0 → 57 kills in one tick is impossible; clamp to +10.
  const res = validateKdaBatch([reading("a1", "teamA", 57, 0, 0)], ctx({ a1: [0, 0, 0] }));
  assert.equal(res.confirmedValues.get("a1")!.kills, 10);
  assert.equal(res.decisions[0].result.status, "candidate");
});

test("kda: savage-speed +5 kills passes clean", () => {
  const res = validateKdaBatch([reading("a1", "teamA", 7, 0, 0)], ctx({ a1: [2, 0, 0] }));
  assert.equal(res.confirmedValues.get("a1")!.kills, 7);
  assert.equal(res.decisions[0].result.status, "confirmed");
});

test("kda: deaths cannot exceed enemy team kills", () => {
  // Enemy (team A) has 0 kills; b1 read with 5 deaths is impossible → roll back.
  const res = validateKdaBatch(
    [reading("a1", "teamA", 0, 0, 0), reading("b1", "teamB", 0, 5, 0)],
    ctx()
  );
  assert.equal(res.confirmedValues.get("b1")!.deaths, 0);
  assert.ok(res.decisions.find((d) => d.playerId === "b1")!.heldBack.some((h) => h.includes("exceed")));
});

test("kda: deaths allowed up to enemy kills", () => {
  const res = validateKdaBatch(
    [reading("a1", "teamA", 3, 0, 0), reading("b1", "teamB", 0, 3, 0)],
    ctx()
  );
  assert.equal(res.confirmedValues.get("b1")!.deaths, 3);
  assert.equal(res.reconciliation.coherent, true);
});

test("validateTeamKills: never-decreases", () => {
  const r = validateTeamKills(3, 7, 5);
  assert.equal(r.status, "rejected");
  assert.equal(r.value, 7);
});

test("validateTeamKills: garbled jump held as candidate", () => {
  const r = validateTeamKills(57, 0, 0);
  assert.equal(r.status, "candidate");
  assert.equal(r.value, 0);
});

test("validateTeamKills: normal increase confirmed", () => {
  const r = validateTeamKills(6, 5, 5);
  assert.equal(r.status, "confirmed");
  assert.equal(r.value, 6);
});

test("validateTeamKills: missing keeps confirmed", () => {
  const r = validateTeamKills(null, 5, 5);
  assert.equal(r.status, "missing");
});
