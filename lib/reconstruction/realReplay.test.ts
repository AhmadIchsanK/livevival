// REAL-DATA replay (spec Phase 6) — runs the reconstruction engine against
// actual production telemetry pulled from the live Supabase, and asserts the
// engine rejects the real corruption the legacy path stored. Every number here
// is real (see __fixtures__/realGames.ts). Divergences found are logged so the
// run doubles as the Phase 4 divergence report.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIRTY_TEAM_A,
  DIRTY_TEAM_B,
  DIRTY_PLAYER_STATS,
  DIRTY_TEAM_KILLS_OVERRIDE,
  DIRTY_OBJECTIVES,
  DIRTY_NW_TEAM_A,
  DIRTY_NW_TEAM_B,
  DIRTY_LEGACY_LATEST_NW,
  CLEAN_NW_TEAM_A,
} from "./__fixtures__/realGames.ts";
import { replayNetWorth, divergeNetWorth, divergeTeamKills, replayObjectives } from "./shadow.ts";

test("REAL: dirty-game team-kills override (73) is rejected by reconstruction", () => {
  const summedB = DIRTY_PLAYER_STATS.filter((p) => p.team === DIRTY_TEAM_B).reduce((s, p) => s + p.k, 0);
  assert.equal(summedB, 0, "Falcons summed player kills");
  const d = divergeTeamKills("team_kills:Falcons", DIRTY_TEAM_KILLS_OVERRIDE[DIRTY_TEAM_B], summedB);
  assert.ok(d, "should diverge");
  assert.equal(d!.category, "LEGACY_WRONG");
  assert.notEqual(d!.reconstructed, 73, "reconstruction must not confirm 73");
  console.log(`  [divergence] ${d!.field}: legacy=${d!.legacy} reconstructed=${d!.reconstructed} (${d!.category})`);
});

test("REAL: team A override (19) vs 17 summed is minor OCR ambiguity, not corruption", () => {
  const summedA = DIRTY_PLAYER_STATS.filter((p) => p.team === DIRTY_TEAM_A).reduce((s, p) => s + p.k, 0);
  assert.equal(summedA, 17);
  const d = divergeTeamKills("team_kills:ONIC", DIRTY_TEAM_KILLS_OVERRIDE[DIRTY_TEAM_A], summedA);
  // 19 vs 17 is within the +10 jump tolerance → confirmed, no divergence.
  assert.equal(d, null, "small lag should be tolerated");
});

test("REAL: dirty-game net worth — reconstruction is monotonic; legacy stored non-monotonic garbage", () => {
  for (const [teamLabel, series, latest] of [
    ["ONIC", DIRTY_NW_TEAM_A, DIRTY_LEGACY_LATEST_NW[DIRTY_TEAM_A]] as const,
    ["Falcons", DIRTY_NW_TEAM_B, DIRTY_LEGACY_LATEST_NW[DIRTY_TEAM_B]] as const,
  ]) {
    const { confirmed, rejected } = replayNetWorth(series);
    // Invariant: reconstruction confirmed sequence never decreases.
    for (let i = 1; i < confirmed.length; i++) {
      assert.ok(confirmed[i] >= confirmed[i - 1], `${teamLabel} nw not monotonic at ${i}`);
    }
    // Legacy stored many readings the engine rejects as decreases/noise.
    assert.ok(rejected.length > 5, `${teamLabel}: expected several rejected readings, got ${rejected.length}`);
    const d = divergeNetWorth(`net_worth:${teamLabel}`, latest, series);
    if (d) console.log(`  [divergence] ${d.field}: legacy=${d.legacy} reconstructed=${d.reconstructed} (${d.category}) — ${d.reason}`);
  }
});

test("REAL: Falcons net worth latest snapshot (18500) is a non-monotonic misread", () => {
  // Legacy shows the last stored value 18500, but it had already stored 26800
  // earlier — the public page would show a LOWER net worth than the team
  // actually reached. Reconstruction holds the monotonic confirmed value.
  const d = divergeNetWorth("net_worth:Falcons", DIRTY_LEGACY_LATEST_NW[DIRTY_TEAM_B], DIRTY_NW_TEAM_B);
  assert.ok(d, "should diverge");
  assert.equal(d!.category, "LEGACY_WRONG");
  assert.ok((d!.reconstructed as number) > (d!.legacy as number));
});

test("REAL: clean-game net worth digit-drop noise (57, 10, 12, 101...) rejected", () => {
  const { rejected, finalConfirmed } = replayNetWorth(CLEAN_NW_TEAM_A);
  const noise = rejected.filter((r) => r.reason.includes("digit-drop"));
  assert.ok(noise.length >= 8, `expected many digit-drop rejects, got ${noise.length}`);
  assert.ok(finalConfirmed >= 18000, `final confirmed climbs to real value, got ${finalConfirmed}`);
  console.log(`  [clean nw] rejected ${rejected.length} readings (${noise.length} digit-drop); final confirmed ${finalConfirmed}`);
});

test("REAL: dirty-game 3 lords at minute 10 — reconstruction confirms only 1", () => {
  const reads = DIRTY_OBJECTIVES.map((o) => ({ type: o.type, minute: o.m }));
  const { confirmed, rejected } = replayObjectives(reads);
  const lords = confirmed.filter((c) => c.type === "lord");
  assert.equal(lords.length, 1, "only one legal lord");
  const rejLords = rejected.filter((r) => r.type === "lord");
  assert.equal(rejLords.length, 2, "two illegal lords rejected");
  console.log(`  [divergence] objective:lord legacy=3 reconstructed=1 (LEGACY_WRONG) — 2 lords within 3-min respawn`);
});
