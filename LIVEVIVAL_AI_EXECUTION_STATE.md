# LIVEVIVAL AI — Execution State (v4.0 Game-State Reconstruction)

Handoff file for resuming autonomous work. Read this first.

_Last updated: 2026-08-11 — branch `claude/hot-match-admin-details-2uqrzt`._

## TL;DR

The **Game-State Reconstruction Engine** (the core of the master plan) is
**implemented, fully unit/replay tested (77/77 passing), type-checked, and it
builds**. It ships **dark** behind feature flags: with the defaults, the live
site is byte-for-byte unchanged (this is the rollback path). A working
**public confirmed-state API** and **admin State Health API** are live and
additive. What remains is the *shadow-mode → switch-public-reads* rollout,
which by design needs a real match to validate against and the additive
migration to be applied to Supabase.

## Completed

- [x] Repo + architecture inspected (Hot Match capture, OCR/tracker model,
      games/player_stats/objectives/net_worth/hero_picks_bans schema, public
      match page + `lib/publicMatches.ts`, realtime).
- [x] Domain model — `lib/reconstruction/types.ts` (branded ids, lifecycle,
      `ConfirmedState`, `ValidationResult`).
- [x] Normalization — `normalize.ts` (timer/kda/netWorth/count; §5 table exact).
- [x] Validators — `timer.ts`, `kda.ts` (batch + reconciliation), `netWorth.ts`,
      `objectives.ts` (turtle/lord/turret/base + physical top/mid/bot×T1-3 model).
- [x] Events — `events.ts` (deterministic idempotent ids, append-only log).
- [x] Kill reconstruction — `killEngine.ts` (atomic KILL from deltas).
- [x] Reducer — `reducer.ts` (pure; GAME_FINISHED lock; correction override).
- [x] Reset detector — `reset.ts` (multi-signal; lone glitch ≠ reset).
- [x] Reconcile — `reconcile.ts`. Health — `health.ts`. Orchestrator —
      `engine.ts`. Replay harness — `replay.ts`. Snapshot/shadow — `snapshot.ts`.
- [x] Additive migration — `supabase/migrations/reconstruction_engine.sql`
      (4 new tables + RLS; nothing altered/dropped). **NOT yet applied.**
- [x] Feature flags — `lib/featureFlags.ts` (all default safe).
- [x] Public confirmed-state API — `app/api/public/match-state/[id]/route.ts`
      + `lib/confirmedState.ts` (legacy-derived today, snapshot when flagged).
- [x] Admin State Health API — `app/api/admin/state-health/[gameId]/route.ts`.
- [x] Docs — `docs/RECONSTRUCTION_ENGINE.md`, this file.
- [x] `test` script (zero-dep `node --experimental-strip-types --test`).

## Verification (this session)

- `npm test` → **77 passing, 0 failing**.
- `npx tsc --noEmit` → **clean** (added `allowImportingTsExtensions: true`).
- `npx next build` → **compiles successfully**; both new routes registered.
- `next lint` → **not configured in this repo** (no `.eslintrc`); left as-is
  rather than introducing a new config mid-project.

## Known limitations / not done

1. **Engine not yet the authoritative writer in the live capture loop.** The
   Hot Match admin page (`app/admin/matches/[id]/live/page.tsx`) still writes
   the legacy tables directly (with its own validation, hardened in prior
   sessions). The reconstruction engine is wired for shadow use but is not
   invoked from the capture tick yet. This is deliberate (migration §38–§40:
   shadow first). Next step below.
2. **Migration not applied to Supabase.** Applying DB schema is an
   irreversible-ish op on production; per the plan it must be applied
   deliberately, then `RECONSTRUCTION_PERSISTENCE` enabled. Until then the
   engine runs in-memory and the public API is legacy-derived.
3. **Public page still reads legacy.** The new `/api/public/match-state/:id`
   contract exists and is correct, but the public match page component has not
   been repointed to it (safe rollback default). Switch after shadow validation.
4. **Realtime/reconnect**: the API returns a per-game `stateVersion` so a client
   can detect missed updates; the existing Supabase realtime subscription on
   the public page is unchanged. A dedicated event-stream subscription on
   `game_events` is a future step (V2 timeline).

## Exact next steps (in order)

1. Apply `supabase/migrations/reconstruction_engine.sql` via Supabase SQL editor.
2. Add a thin persistence adapter that, inside `captureTickBody`, ALSO builds an
   `ObservationTick` and calls `engine.ingest()` + upserts `game_observations` /
   `game_events` / `confirmed_game_state` (guarded by `RECONSTRUCTION_PERSISTENCE`).
   Do **not** remove the legacy writes yet.
3. Enable `RECONSTRUCTION_SHADOW_MODE`; run one real match; diff via
   `shadowCompare()`; log divergences; fix validators until divergences are
   understood/zero. Turn each divergence into a replay regression test.
4. Enable `RECONSTRUCTION_PUBLIC_READS`; repoint the public match page to
   `/api/public/match-state/:id`. Keep the flag off = instant rollback.
5. Only after sustained clean shadow runs, retire the legacy direct-mutation
   writes.

## Important decisions

- **Zero new dependencies.** Engine is erasable-TS; tests run on Node's built-in
  runner. Keeps the bundle and supply chain unchanged.
- **`.ts`-extension imports** in the engine (required by `--strip-types`) are
  accepted by `tsc` via `allowImportingTsExtensions` and bundle fine in Next.
- **Additive-only DB changes**; rollback = drop new tables + flags off.
- **Turtle cap is per-game = 4, shared** (confirmed with the owner previously).
