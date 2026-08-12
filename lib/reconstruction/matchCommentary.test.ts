// Tests for lib/matchCommentary (kept under the reconstruction glob so
// `npm test` picks it up). Deterministic RNG (() => 0 always picks the first
// phrasing) so assertions are stable.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickCommentary,
  commentaryCandidates,
  renderTemplate,
  COMMENTARY_CONDITIONS,
  type CommentaryCondition,
  type CommentarySnapshot,
  type CommentaryContext,
} from "../matchCommentary.ts";

const rngFn = () => 0;
const rng = { rng: rngFn };
const ALL = new Set<CommentaryCondition>(COMMENTARY_CONDITIONS.map((c) => c.key));
const A = { id: "A", name: "ONIC" };
const B = { id: "B", name: "FLCN" };

function snap(over: Partial<CommentarySnapshot> = {}): CommentarySnapshot {
  return {
    timerSeconds: 600,
    teamA: A,
    teamB: B,
    netWorth: { A: 20000, B: 20000 },
    teamKills: { A: 0, B: 0 },
    objectives: { A: { turtle: 0, lord: 0, tower: 0 }, B: { turtle: 0, lord: 0, tower: 0 } },
    players: [],
    winProbA: 0.5,
    ...over,
  };
}
function ctx(now: CommentarySnapshot, prev: CommentarySnapshot | null = null, enabled = ALL): CommentaryContext {
  return { now, prev, enabled };
}

test("dominating net-worth lead is called out", () => {
  const c = commentaryCandidates(ctx(snap({ netWorth: { A: 34000, B: 20000 } })), rng);
  assert.ok(c.some((l) => l.condition === "net_worth" && /ONIC/.test(l.text) && /14\.0k/.test(l.text)));
});

test("close game is called out", () => {
  const c = commentaryCandidates(ctx(snap({ netWorth: { A: 20500, B: 20000 } })), rng);
  assert.ok(c.some((l) => l.condition === "net_worth" && /even|Anyone|Neck/i.test(l.text)));
});

test("comeback: trailing team closes the gold gap", () => {
  const prev = snap({ netWorth: { A: 30000, B: 20000 } }); // A +10k
  const now = snap({ netWorth: { A: 30000, B: 26000 } }); // A +4k (B closed 6k)
  const c = commentaryCandidates(ctx(now, prev), rng);
  assert.ok(c.some((l) => l.condition === "net_worth" && /FLCN/.test(l.text) && /clawing|closing/i.test(l.text)));
});

test("kill lead and fresh teamfight both surface", () => {
  const prev = snap({ teamKills: { A: 3, B: 3 } });
  const now = snap({ teamKills: { A: 10, B: 4 } }); // A leads 10-4, +8 total kills since prev
  const c = commentaryCandidates(ctx(now, prev), rng);
  assert.ok(c.some((l) => l.condition === "kills" && /10–4|commanding|bullying/.test(l.text)));
  assert.ok(c.some((l) => l.condition === "kills" && /erupt|skirmish/i.test(l.text)));
});

test("tower / turtle / lord pickups are narrated on increment", () => {
  const prev = snap();
  const now = snap({ objectives: { A: { turtle: 1, lord: 1, tower: 3 }, B: { turtle: 0, lord: 0, tower: 0 } } });
  const c = commentaryCandidates(ctx(now, prev), rng);
  assert.ok(c.some((l) => l.condition === "tower"));
  assert.ok(c.some((l) => l.condition === "turtle"));
  assert.ok(c.some((l) => l.condition === "lord" && /LORD|Lord/.test(l.text)));
});

test("unkillable player is highlighted", () => {
  const now = snap({ players: [{ id: "p1", name: "Kairi", teamId: "A", kills: 6, deaths: 0, assists: 2, heroName: "Ling" }] });
  const c = commentaryCandidates(ctx(now), rng);
  assert.ok(c.some((l) => l.condition === "player_kda" && /unkillable|touch/i.test(l.text) && /Kairi/.test(l.text)));
});

test("win probability: decisive lead and momentum swing", () => {
  const prev = snap({ winProbA: 0.5 });
  const now = snap({ winProbA: 0.9 });
  const c = commentaryCandidates(ctx(now, prev), rng);
  assert.ok(c.some((l) => l.condition === "win_prob" && /90%|driver/.test(l.text)));
  assert.ok(c.some((l) => l.condition === "win_prob" && /Momentum|needle/i.test(l.text)));
});

test("enabled-condition filter excludes disabled categories", () => {
  const now = snap({ netWorth: { A: 34000, B: 20000 }, teamKills: { A: 10, B: 2 } });
  const onlyKills = new Set<CommentaryCondition>(["kills"]);
  const c = commentaryCandidates(ctx(now, null, onlyKills), rng);
  assert.ok(c.length > 0);
  assert.ok(c.every((l) => l.condition === "kills"), "no net_worth/general lines when only kills enabled");
});

test("pickCommentary prefers event-driven lines over ambient filler", () => {
  const prev = snap({ teamKills: { A: 0, B: 0 } });
  const now = snap({ teamKills: { A: 5, B: 0 }, timerSeconds: 120 }); // early game (general) + a fight
  const line = pickCommentary(ctx(now, prev), rng);
  assert.ok(line);
  assert.notEqual(line!.condition, "general", "an event beats pacing filler");
});

test("pickCommentary returns a pacing line when nothing else is happening", () => {
  // Gold diff of 3k sits in the dead zone (not close, not a real lead), no
  // kills/objectives/players/prev — so only the ambient pacing line remains.
  const line = pickCommentary(ctx(snap({ timerSeconds: 1200, netWorth: { A: 23000, B: 20000 } })), rng);
  assert.ok(line);
  assert.equal(line!.condition, "general");
});

test("nothing enabled → no commentary", () => {
  const line = pickCommentary(ctx(snap({ netWorth: { A: 34000, B: 20000 } }), null, new Set()), rng);
  assert.equal(line, null);
});

test("renderTemplate interpolates placeholders; null when a placeholder is missing", () => {
  assert.equal(renderTemplate("{lead} up {diff}", { lead: "ONIC", diff: "14.0k" }), "ONIC up 14.0k");
  assert.equal(renderTemplate("{lead} up {diff}", { lead: "ONIC" }), null, "missing {diff} → skip");
  assert.equal(renderTemplate("no placeholders here", {}), "no placeholders here");
});

test("custom DB template fires for its condition and is tagged as custom", () => {
  const now = snap({ netWorth: { A: 34000, B: 20000 } });
  const c = commentaryCandidates(ctx(now), {
    rng: rngFn,
    templates: [{ condition: "net_worth", template: "{lead} making it look easy, {diff} clear.", enabled: true }],
  });
  const custom = c.find((l) => l.source === "custom");
  assert.ok(custom, "custom template produced a line");
  assert.equal(custom!.text, "ONIC making it look easy, 14.0k clear.");
});

test("a disabled custom template does not fire", () => {
  const now = snap({ netWorth: { A: 34000, B: 20000 } });
  const c = commentaryCandidates(ctx(now), {
    rng: rngFn,
    templates: [{ condition: "net_worth", template: "should not appear {diff}", enabled: false }],
  });
  assert.ok(!c.some((l) => l.source === "custom"));
});

test("custom template using a placeholder the trigger lacks is skipped", () => {
  // The dominating-lead trigger supplies {lead}/{trail}/{diff} but NOT {closed}.
  const now = snap({ netWorth: { A: 34000, B: 20000 } });
  const c = commentaryCandidates(ctx(now), {
    rng: rngFn,
    templates: [{ condition: "net_worth", template: "comeback {closed}", enabled: true }],
  });
  assert.ok(!c.some((l) => l.text.includes("comeback")), "template needing {closed} never renders on a lead trigger");
});
