import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRows, snapshotRow, observationId, buildIngestPayload } from "./persistence.ts";
import { reduceEvents } from "./reducer.ts";
import { createEvent } from "./events.ts";
import { asGameId, asTeamId, asPlayerId } from "./types.ts";
import type { GameEvent } from "./types.ts";

const G = asGameId("g1");
const A = asTeamId("A");
const B = asTeamId("B");

function ev(type: GameEvent["type"], payload: any, t = 0, sig = JSON.stringify(payload)): GameEvent {
  return { ...createEvent({ gameId: G, type, gameTimeSeconds: t, payload, source: "ocr", confidence: 1, signature: sig }), seq: 1 };
}

test("eventRows: maps engine events to DB row shape", () => {
  const rows = eventRows([ev("KILL", { killerTeamId: A, victimTeamId: B }, 120)], "match1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].game_id, "g1");
  assert.equal(rows[0].match_id, "match1");
  assert.equal(rows[0].type, "KILL");
  assert.equal(rows[0].status, "confirmed");
  assert.ok(rows[0].event_id.startsWith("kill_"));
});

test("snapshotRow: carries state_version + public contract", () => {
  const s = reduceEvents(G, [ev("GAME_STARTED", {}), ev("NET_WORTH_UPDATE", { teamId: A, gold: 5500 }, 60)]);
  const row = snapshotRow(s, "match1");
  assert.equal(row.game_id, "g1");
  assert.equal(row.state_version, s.stateVersion);
  assert.equal(row.state.netWorth["A"].display, "5.5K");
});

test("observationId: deterministic (idempotent evidence)", () => {
  const a = observationId("g1", "game_timer", 120, "02:00");
  const b = observationId("g1", "game_timer", 120, "02:00");
  const c = observationId("g1", "game_timer", 121, "02:01");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("buildIngestPayload: only confirmed events, with snapshot", () => {
  const confirmed = ev("KILL", { killerTeamId: A, victimTeamId: B }, 120);
  const candidate = { ...ev("KILL", { killerTeamId: B, victimTeamId: A }, 121, "cand"), status: "candidate" as const };
  const s = reduceEvents(G, [ev("GAME_STARTED", {}), confirmed]);
  const payload = buildIngestPayload({ state: s, newEvents: [confirmed, candidate], matchId: "match1" });
  assert.equal(payload.events.length, 1, "candidate excluded");
  assert.equal(payload.events[0].status, "confirmed");
  assert.equal(payload.snapshot.game_id, "g1");
  assert.equal(payload.gameId, "g1");
});
