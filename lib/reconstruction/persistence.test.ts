import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRows, snapshotRow, observationId, buildIngestPayload, observationRowsFromDiagnostics } from "./persistence.ts";
import { reduceEvents } from "./reducer.ts";
import { createEvent } from "./events.ts";
import { createEngine, ingest } from "./engine.ts";
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

test("observationRowsFromDiagnostics: engine diagnostics → CV observation rows", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, {
    gameTimeSeconds: 60,
    timer: 60,
    netWorth: { A: 5000 },
    playerKda: [{ playerId: asPlayerId("p1"), teamId: A, kda: { kills: 1, deaths: 0, assists: 0 } }],
    source: "ocr",
    confidence: 0.9,
  });
  const rows = observationRowsFromDiagnostics(e.diagnostics, "g1", "match1", e.state.timerSeconds);
  // net_worth:A → team row; player_kda:p1 → player row; game_timer → bare.
  const nw = rows.find((r) => r.field === "net_worth");
  assert.ok(nw, "expected a net_worth observation");
  assert.equal(nw!.team_id, "A");
  assert.equal(nw!.player_id, null);
  assert.equal(nw!.source, "ocr");
  const kda = rows.find((r) => r.field === "player_kda");
  assert.ok(kda, "expected a player_kda observation");
  assert.equal(kda!.player_id, "p1");
  assert.equal(kda!.team_id, null);
  // Diagnostic-only pending keys must never become observation rows.
  assert.ok(!rows.some((r) => r.field.includes("pending")));
});

test("buildIngestPayload: includes CV observations when diagnostics passed", () => {
  const e = createEngine({ gameId: G, teamAId: A, teamBId: B });
  ingest(e, { gameTimeSeconds: 60, timer: 60, netWorth: { A: 5000 }, source: "ocr", confidence: 0.9 });
  const withDiag = buildIngestPayload({ state: e.state, newEvents: [], matchId: "m1", diagnostics: e.diagnostics });
  assert.ok((withDiag.observations?.length ?? 0) > 0);
  const without = buildIngestPayload({ state: e.state, newEvents: [], matchId: "m1" });
  assert.equal(without.observations, undefined);
});
