# LIVEVIVAL AI — Execution State (v4.0 Game-State Reconstruction)

Handoff file for resuming autonomous work. Read this first.

_Last updated: 2026-08-11 — branch `claude/hot-match-admin-details-2uqrzt`._

## TL;DR

The reconstruction engine is implemented, unit + **real-data** tested (92
tests), type-checked, and it builds. It is now **integrated into the real Hot
Match capture loop in shadow mode** (off by default) and the **additive DB
migration has been applied to the live Supabase and verified**. The engine was
validated against **real production telemetry** and it rejects genuine
corruption already present in the live database. Public reads are **not** yet
switched — that is the next gate. Current readiness: **SHADOW READY**.

## Real-data evidence (validated against live Supabase, project oieootgmrryetsgvyaky)

Pulled two finished games and replayed their real telemetry through the engine
(`lib/reconstruction/realReplay.test.ts`, fixtures in `__fixtures__/realGames.ts`):

| Game | Real corruption in legacy DB | Reconstruction result | Category |
|------|------------------------------|-----------------------|----------|
| ONIC vs Falcons (e6d55ae8) | `team_b_kills_override = 73`, but all 10 players sum to **0** Falcons kills | engine holds **0** (rejects the 73 jump) | LEGACY_WRONG |
| ONIC vs Falcons | net worth public value shows **32500 / 18500**, but the team had already reached 40000 / 26800 | engine holds monotonic **40000 / 26800**, rejecting **48 / 55** non-monotonic/noise readings | LEGACY_WRONG |
| ONIC vs Falcons | **3 Lord kills** all stamped minute 10 (impossible, 3-min respawn) | engine confirms **1**, rejects 2 | LEGACY_WRONG |
| Selangor vs Aurora (43ab7433) | net worth series littered with digit-drop noise (`57`, `10`, `12`, `101`, …) | engine rejects **15** noise reads, climbs to real 18400 | OCR_AMBIGUITY / LEGACY_WRONG |

This is the core proof the architecture works on real data, not fixtures.

## Observation mappings (real Hot Match OCR → reconstruction model)

Mapped in `captureTickBody` (`app/admin/matches/[id]/live/page.tsx`) via a
`shadowReads` accumulator → `runShadowTick` (`lib/reconstruction/shadowCapture.ts`):

| Hot Match OCR field | Reconstruction observation | Status |
|---------------------|----------------------------|--------|
| `game_timer` (mm:ss) | `tick.timer` (seconds) | ✅ mapped |
| `team_kills` (per side) | `tick.teamKills[teamId]` | ✅ mapped |
| `player_kda` / `kda_group` | `tick.playerKda[]` | ✅ mapped |
| `net_worth` (left/right) | `tick.netWorth[teamId]` | ✅ mapped |
| `objective` / `objectives_group` (turtle/lord/tower) | `tick.objectives.*` | ✅ mapped |
| `base` / game finish | `tick.baseDestroyed` / `gameFinished` | ✅ (via game.status/phase) |
| `kill_banner` (semantic) | supporting evidence only | ⚠️ observed, not yet an event source |
| `victory_banner` (semantic) | legacy suggestedWinner | ⚠️ NOT mapped to engine (semantic) |
| hero pick/ban | separate draft model | ⏸️ UNSUPPORTED in engine v1 (out of scope; V3) |
| turret exact lane (top/mid/bot×T1-3) | model exists; no per-lane OCR yet | ⚠️ count only; lane = NOT AVAILABLE from current stream |
| level / items / spells | — | ⏸️ UNSUPPORTED (V4, behind flags) |

## Completed this session (real integration)

- [x] Traced the real `captureTickBody` capture loop; identified the safe flush point.
- [x] `lib/reconstruction/shadowCapture.ts` — client-safe live shadow adapter
      (per-game engine, maps reads → ObservationTick, compares to legacy,
      categorizes divergences; wrapped so it can never break capture).
- [x] Wired a `shadowReads` accumulator + flush into `captureTickBody`
      (trivial per-case assignments; flush gated by `clientShadowModeEnabled()`,
      off by default). Legacy writes 100% unchanged.
- [x] Admin divergence panel in the live page (renders only when shadow on).
- [x] `lib/reconstruction/shadow.ts` — divergence categorization + net-worth /
      team-kills / objectives replay analysis.
- [x] `lib/reconstruction/realReplay.test.ts` + `__fixtures__/realGames.ts` —
      real production telemetry replay (see evidence table).
- [x] `lib/reconstruction/acceptance.test.ts` — Phase 9 criteria as named tests.
- [x] **Applied `reconstruction_engine.sql` to the live DB** (4 tables, RLS,
      idempotency constraint) and verified.
- [x] Client shadow flag (`clientShadowModeEnabled`, NEXT_PUBLIC / localStorage).

## Verification (this session)

- `npm test` → **92 passing, 0 failing** (incl. real-data replay + acceptance).
- `npx tsc --noEmit` → clean.
- `npx next build` → compiles; capture-loop integration bundles; both new routes registered.
- DB migration → applied + verified (rls=true, 1 policy each, unique constraint present).

## Known limitations / not done (deliberate)

1. **Public reads still legacy.** `/api/public/match-state/:id` works but in
   legacy-derived mode it faithfully mirrors legacy "confirmed" state — which
   still includes corruption like the 73 kills (it uses the same
   `max(override, summed)` the legacy pages use). The corruption is only FIXED
   once `RECONSTRUCTION_PUBLIC_READS` is on AND the engine populates
   `confirmed_game_state`. This is correct shadow-first sequencing.
2. **No historical backfill possible.** Past games have no per-tick
   `game_observations` (that table is new), only final legacy state, so the
   engine cannot retro-reconstruct old games. Reconstruction applies to games
   captured from now on with shadow persistence enabled.
3. **Shadow persistence IMPLEMENTED + schema-verified, not yet exercised live.**
   `lib/reconstruction/persistence.ts` (row builders + idempotency),
   `app/api/admin/reconstruction/ingest/route.ts` (admin + service-role,
   idempotent upserts, gated by `RECONSTRUCTION_PERSISTENCE`), and a
   fire-and-forget client call (opt-in `localStorage['livevival:shadow:persist']`
   AND server flag). Idempotency verified against the live schema in a
   BEGIN/ROLLBACK transaction (dup event → no-op; snapshot upsert → version
   advances). No live capture has exercised it yet.
4. **Not yet run against a live match by a human.** The engine is validated
   against real historical data via replay; a live shadow run with the admin
   panel + persistence is the SHADOW VALIDATED gate — and it REQUIRES a human
   operator screen-sharing a live MLBB broadcast into the Hot Match console.
   This cannot be performed by the agent (no browser, no live stream).

## Exact next steps (in order) — REQUIRE A HUMAN + LIVE STREAM

1. Set `RECONSTRUCTION_PERSISTENCE=1` in the deployment env (server flag).
2. In the admin browser during a REAL live Hot Match, set
   `localStorage['livevival:shadow']='1'` and
   `localStorage['livevival:shadow:persist']='1'`, then run capture through a
   full game. Watch the divergence panel; confirmed_game_state / game_events
   fill in as the game progresses.
3. Collect divergences across the full match; classify each (LEGACY_WRONG /
   RECONSTRUCTION_WRONG / OCR_* / TIMING / MAPPING / EXPECTED); turn any
   RECONSTRUCTION_WRONG into a replay regression test + fix.
4. When the Phase-9 acceptance criteria hold on live data, enable
   `RECONSTRUCTION_PUBLIC_READS=1` and repoint the public match page to
   `/api/public/match-state/:id`. Flag off = instant rollback.

The agent cannot do step 2 (no browser / no live MLBB stream). Everything the
agent can safely build without inventing a live result is done.

## Rollback

- Public: every flag defaults off → site unchanged. Turning shadow off (default)
  removes all engine involvement.
- DB: `drop table game_state_corrections, confirmed_game_state, game_events, game_observations cascade;`
  (all additive; no existing table touched).

## First live shadow run — 2026-08-12 (game bca5ba0c, ONIC vs Falcons)

387 events persisted, 1 snapshot, `RECONSTRUCTION_PERSISTENCE` on, public reads OFF.

**Passed on live data:** idempotency (0 duplicate event_ids; seq 1–387 distinct),
timer strictly monotonic (0 rollbacks), net worth strictly monotonic per team
(0 decreases — the exact corruption class the engine targets), objectives legal
(turtle 2, lord 1), single game (no cross-game contamination), persistence
stable, capture unaffected.

**One real reconstruction bug found + fixed:** the team-kills aggregate tracker
minted one orphan `KILL` per unattributed increment — with null killer AND null
victim — inflating Team A confirmed team kills to **27** while its five players
summed to **19** (8 fabricated kills; `kills_null_killer=8`). Violated spec §21
and "player kills sum to team kills". Fix: the team-kills tracker is now a
CROSS-CHECK ONLY (surfaces a candidate divergence); confirmed team kills derive
purely from player-attributed events, so `teamKills == player-sum` always.
`reconcile()` tightened to flag over-sum too. Regression tests in
`liveRegression.test.ts`. NOTE: game bca5ba0c's persisted snapshot still shows
the pre-fix 27 (kept as evidence; shadow-only, not served).

**Known OCR limitation (not a reconstruction bug):** deaths were under-read by
OCR (Team B 6 deaths recorded vs ~19 kills against them), so the "Team A kills =
Team B deaths" identity cannot hold on this stream. The engine correctly does
NOT fabricate deaths; `reconcile()` surfaces it as a conflict
(MISSING_OBSERVATION). Full kills=deaths reconciliation needs better death OCR.

## Second live run — 2026-08-12 (game 350724b4) — audited, STILL FAILS

240 events. Audit of the persisted data: `null_killer_kills = 28`, `teamKills`
A=11 vs player-sum 3, B=20 vs player-sum 0. The null-killer KILL events have
payload `{killerTeamId, victimTeamId}` with NO killerPlayerId/victimPlayerId
keys — the exact signature of the OLD (pre-PR#152) team_kills orphan path;
the fixed `reconstructKills` always writes those keys. Timeline confirms it:
fix merged ~02:35, game captured 02:39–02:49 (before Vercel could
build/deploy/propagate to the browser). **So the second run used the PRE-FIX
client build; it does NOT validate the fix.** Also ended `in_progress` (no base
destruction), so GAME_FINISHED lock was again not exercised live. PASSED on this
data: 0 duplicate events, 0 timer rollbacks, 0 net-worth decreases, legal
objectives, game isolation, persistence integrity.

Decision: **public reads NOT enabled.** No new engine bug (the fix is correct;
this run just didn't use it).

## Tracker/UI changes this session (admin Hot Match console)

- "Which team is on the left?" moved to the top of Match Capture next to Declare
  Game Winner; **auto-set from the draft** (Blue = Left) in `startDraftSimulation`.
- Removed the **team-kills** tracker (catalog + auto-place + field map) AND
  hard-excluded it (plus per-team `objective` and per-player `player_kda`
  trackers) from the capture loop via `RETIRED_TRACKER_CATEGORIES` — even a stale
  calibration can no longer feed a bad team-kill count. Team kills are derived
  from the players' combined K/D/A (matches the engine).
- Combined objectives reading order fixed: left = Turtle/Lord/Tower, right =
  Tower/Lord/Turtle (`OBJECTIVE_GROUP_ORDER`) — the previous reversed order was
  why objective counts "never followed the number logic" (numbers landed on the
  wrong type).
- Kill-banner detection rewritten to match a letters-only normalization
  (`bannerMatch`) with tolerant substrings (SAVAGE/MANIAC/TRIPLE/DOUBLE) — the
  strict word-boundary regexes never fired on real stylized banners.
- Match-capture pane no longer clamped to viewport height (`lg:sticky/max-h`
  removed) so the tracker menu stays visible at a 60:40 split.
- Net worth: no change needed (already correct).

## Readiness: **SHADOW READY** — two live runs attempted; neither validated the
fixed build (run 1 was pre-fix and surfaced the bug; run 2 was ALSO pre-fix due
to deploy timing). Reaching SHADOW VALIDATED requires ONE live game confirmed to
be running the deployed fixed build (verify `null_killer_kills = 0` in that
game's events), ideally through base destruction. Public reads remain OFF.

### How to confirm the browser has the fixed build before the next run
In the admin console, run a capture tick and check the persisted `game_events`
for the new game: `select count(*) from game_events where game_id=<new> and
type='KILL' and not (payload ? 'killerPlayerId')` must be **0**. If >0, the
browser is still serving a cached pre-fix bundle — hard-reload before validating.
