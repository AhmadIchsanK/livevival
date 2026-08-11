# Livevival — Game-State Reconstruction Engine (v4.0)

> OCR/vision observations are **not** truth. Only **confirmed events** and the
> **state derived from them** are truth. A single bad OCR frame must never
> become incorrect confirmed game state.

This document is the architecture map for the reconstruction engine added in
v4.0. It implements the target pipeline from
`LIVEVIVAL_AI_EXECUTION_MASTER_PLAN` and `LIVEVIVAL_AI_SINGLE_RUN_MASTER_PROMPT`.

## Pipeline

```
STREAM
  → OCR / VISION OBSERVATIONS      (raw evidence, append-only)
  → NORMALIZATION                  (typed candidate values; the only OCR parser)
  → VALIDATION                     (game-logic rules → confirmed/candidate/rejected)
  → CONFIRMED EVENTS               (first-class, idempotent, replayable)
  → GAME-STATE REDUCER             (pure; events → confirmed state)
  → CONFIRMED SNAPSHOT             (materialized for fast public reads)
  → PUBLIC CONFIRMED-STATE API     (exposes confirmed data only)
  → PUBLIC LIVE PAGE               (renders; runs no validation itself)
```

## Modules (`lib/reconstruction/`)

| File | Responsibility | Spec |
|------|----------------|------|
| `types.ts` | Branded ids, `GameStatus`, event/observation lifecycle, `ConfirmedState`, `ValidationResult` | §07–§10 |
| `normalize.ts` | RAW OCR → typed values (kda/timer/netWorth/count). The **only** string parser. | §11 |
| `validators/timer.ts` | Monotonic timer; decrease only via reset; primary temporal reference | §06, §13 |
| `validators/kda.ts` | Whole-tick batch: monotonic clamp, per-tick spike ceiling, deaths ≤ enemy kills, team-kill reconciliation | §04, §14, §22 |
| `validators/netWorth.ts` | Monotonic; single-digit noise & spike guards; keep-confirmed on missing | §05, §15 |
| `validators/objectives.ts` | Turtle / Lord / Turret / Base state machines with timer windows | §07, §08, §09, §16, §17 |
| `events.ts` | Event factory, **deterministic idempotent ids**, append-only log with monotonic seq | §09, §37 |
| `killEngine.ts` | Stat deltas → atomic `KILL` events (killer/victim/assists); totals reconcile | §21 |
| `reducer.ts` | Pure events → `ConfirmedState`; **GAME_FINISHED lock**; manual-correction override | §10, §19, §23 |
| `reset.ts` | Multi-signal reset detector; a lone timer glitch never resets | §10, §18 |
| `reconcile.ts` | Cross-field coherence report (which constraint failed) | §22 |
| `health.ts` | Admin State Health per-field view (confirmed/candidate/confidence/stale/reason) | §24 |
| `engine.ts` | Orchestrator: one observation tick → events + state through the real pipeline | §03 |
| `replay.ts` | Replay harness feeding ticks through the **production** `ingest()` | §32 |
| `snapshot.ts` | `PublicGameState` contract + legacy↔reconstructed **shadow compare** | §26, §39 |

## Absolute rules enforced in code

- **Missing OCR → keep last confirmed** (validators return `missing`, reducer
  never lowers a value; public API reads persisted values so a gap shows the
  last confirmed value, never `0`/`null`).
- **Lower value → reject** unless a new game is confirmed (`reset.ts`).
- **Suspicious increase → candidate**, never silently trusted (spike ceilings).
- **Impossible relationship → reject** (deaths ≤ enemy kills; team A kills =
  team B deaths).
- **One kill = 1 killer + 1 victim + 0–4 assists**, reconstructed atomically.
- **GAME_FINISHED freezes** kills/deaths/assists/net worth/objectives/turrets;
  only an audited `MANUAL_CORRECTION` may change a finished game.
- **Duplicate frames are idempotent** — deterministic event ids collapse a
  re-delivered observation window to a single event.
- **Game isolation** — the reducer is per-`game_id`; a `GAME_RESET` boundary
  archives the old context (no cross-game monotonicity).

## Data model (additive migration)

`supabase/migrations/reconstruction_engine.sql` adds **only new tables**
(nothing altered/dropped, so rollback is a plain `DROP`):

- `game_observations` — append-only raw evidence (raw + normalized + confidence).
- `game_events` — confirmed, replayable events; `unique(game_id, event_id)` gives
  DB-level idempotency.
- `confirmed_game_state` — materialized snapshot + `state_version` for reconnect.
- `game_state_corrections` — manual-correction audit trail.

RLS: public may read `confirmed_game_state` and **confirmed** `game_events`
only; observations/corrections are admin-only; all writes are service-role.

## Rollout / rollback (feature flags — `lib/featureFlags.ts`)

All flags default to **safe/legacy** behavior. **With every flag off (the
default), the site behaves exactly as before v4.0** — this is the rollback path.

| Flag (env) | Default | Effect |
|-----------|---------|--------|
| `RECONSTRUCTION_PERSISTENCE` | off | Persist observations/events/snapshot (needs migration applied) |
| `RECONSTRUCTION_SHADOW_MODE` | off | Run engine alongside legacy, log divergences; **no public change** |
| `RECONSTRUCTION_PUBLIC_READS` | off | Serve public API from reconstruction snapshot instead of legacy-derived |
| `ADMIN_STATE_HEALTH` | on | Expose admin State Health route (read-only, admin-guarded) |

## Public API

`GET /api/public/match-state/:id` → confirmed state for every game in a match
(timer, team kills, per-player K/D/A, net worth with `xx.xK`, objectives, turret
state, per-game `stateVersion`). Exposes confirmed data only. Works **today**
(legacy-derived) before the migration is applied; switches to the reconstruction
snapshot when `RECONSTRUCTION_PUBLIC_READS` is on.

## Admin API

`GET /api/admin/state-health/:gameId` (admin bearer token) → per-field State
Health + reconciliation conflicts, derived from persisted state via the same
`reconcile()` the engine uses.

## Tests

`npm test` runs the whole suite with **zero extra dependencies**
(`node --experimental-strip-types --test`). 77 tests: normalization, every
validator, events/idempotency, reducer + finished-lock, kill engine, reset,
reconcile, snapshot/shadow, health, a full-game replay, and the failure matrix
(missing OCR, garbled spike, impossible KDA, net-worth spike, timer rollback,
post-game frames, false vs real reset, duplicate frames, illegal objectives).

## Integration status

The engine is **complete, tested, and shipped dark**. It is not yet wired into
the live Hot Match capture loop as the authoritative writer — that switch is
gated behind shadow-mode acceptance per the migration strategy (§38–§40). See
`LIVEVIVAL_AI_EXECUTION_STATE.md` for the exact next steps.
