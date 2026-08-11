import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvent, createLog, appendEvent, orderedEvents, makeEventId } from "./events.ts";
import { asGameId } from "./types.ts";

const G = asGameId("g1");

test("event id is deterministic for same identity", () => {
  const id1 = makeEventId(G, "KILL", 100, "a>b");
  const id2 = makeEventId(G, "KILL", 100, "a>b");
  const id3 = makeEventId(G, "KILL", 101, "a>b");
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

test("append is idempotent — duplicate event is a no-op", () => {
  let log = createLog(G);
  const e = createEvent({ gameId: G, type: "KILL", gameTimeSeconds: 100, payload: { killerTeamId: "a" as any, victimTeamId: "b" as any }, source: "ocr", confidence: 0.9, signature: "a>b#0" });
  const r1 = appendEvent(log, e);
  const r2 = appendEvent(log, e);
  assert.equal(r1.appended, true);
  assert.equal(r2.appended, false);
  assert.equal(log.events.length, 1);
});

test("append assigns monotonic seq", () => {
  let log = createLog(G);
  const mk = (sig: string) => createEvent({ gameId: G, type: "KILL", gameTimeSeconds: 100, payload: {} as any, source: "ocr", confidence: null, signature: sig });
  appendEvent(log, mk("x"));
  appendEvent(log, mk("y"));
  assert.deepEqual(log.events.map((e) => e.seq), [1, 2]);
});

test("orderedEvents sorts by game time then seq", () => {
  let log = createLog(G);
  const mk = (t: number, sig: string) => createEvent({ gameId: G, type: "KILL", gameTimeSeconds: t, payload: {} as any, source: "ocr", confidence: null, signature: sig });
  appendEvent(log, mk(200, "late"));
  appendEvent(log, mk(100, "early"));
  const ordered = orderedEvents(log);
  assert.equal(ordered[0].gameTimeSeconds, 100);
  assert.equal(ordered[1].gameTimeSeconds, 200);
});
