# LIVEVIVAL — Live Validation Runbook & Acceptance Gate

Derived from the AI Engineering Execution Spec (slides 37–39, 43–44). This is
the operator procedure for the one thing that **cannot be proven by synthetic
tests**: a real Hot Match producing real telemetry through the reconstruction
pipeline, ending in a real crystal destruction, compared against the legacy
path — before any public-read cutover.

> **Rule (slide 44):** Live-required criteria may **never** be marked passed by
> unit/replay tests alone, and live validation must not be faked. The evidence
> is the persisted real-match data, not a green test run.

---

## What is already automated (no live match needed)

- Unit + replay + acceptance suites: `npm test` (`node --experimental-strip-types --test`).
- Confidence/evidence bands (§30), AI-vision observer (§25–27), CV+AI fusion
  (§28–29) — all pure and unit-covered.
- Shadow mode compares reconstruction vs legacy per tick in the admin console.

## Flags involved (all default-safe)

| Flag / toggle | Where | Purpose |
|---|---|---|
| `livevival:shadow` (localStorage `=1`) | admin browser | run the engine in shadow alongside capture |
| `livevival:shadow:persist` (localStorage `=1`) | admin browser | also POST events + **CV observations** to the ingest route |
| `RECONSTRUCTION_PERSISTENCE` | server env | ingest route actually writes `game_events` / `confirmed_game_state` / `game_observations` (else 204 no-op) |
| `RECONSTRUCTION_AI_OBSERVER` | server env | AI frame-analysis also records `source="vision"` observations |
| `RECONSTRUCTION_PUBLIC_READS` | server env | public API serves the reconstructed snapshot (**cutover — enable last**) |

CV observations (`source="ocr"`) persist only when **both** the client
`shadow:persist` opt-in and server `RECONSTRUCTION_PERSISTENCE` are on, and only
on ticks that produced a confirmed event — so the table isn't flooded.

---

## Before the match (slide 39)

1. Deploy; **hard-refresh** the admin console after deploy; confirm build/version.
2. In the admin browser console: `localStorage.setItem('livevival:shadow','1')`
   and `localStorage.setItem('livevival:shadow:persist','1')`.
3. Server env: `RECONSTRUCTION_PERSISTENCE=1` (and `RECONSTRUCTION_AI_OBSERVER=1`
   if validating the AI observer). **Leave `RECONSTRUCTION_PUBLIC_READS=0`.**
4. Record the **game ID** (visible in the Hot Match console).

## During the match (slide 39)

Watch, per field, the diagnostics (crop / raw / normalized / candidate /
confirmed / reason / band):

- **Timer** — monotonic; only decreases after a confirmed new game.
- **Net worth** — monotonic; spikes held as candidate, decreases rejected.
- **Player KDA** — assists never exceed team kills; deaths never exceed enemy
  kills; team kills = Σ player kills.
- **Objectives** — plausible counts, correct sub-region/team mapping.
- **Fusion** (State Health `fusion` section) — CV/AI `agree` boosts the band;
  `conflict` holds and logs, never averages.

## End of the match (slide 39)

- Capture **through crystal destruction** when possible.
- Verify `GAME_FINISHED` fired and the **finish lock** rejects post-finish
  telemetry.

## After the match (slide 39)

- Audit persisted `game_events` / `confirmed_game_state` / `game_observations`.
- Compare reconstructed vs legacy (shadow divergence panel / State Health).
- **Only if the acceptance matrix passes**, enable `RECONSTRUCTION_PUBLIC_READS=1`.

---

## Acceptance matrix (slide 38) — must pass on real data

- [ ] Timer monotonic across the whole game.
- [ ] Net worth monotonic; no implausible spike became confirmed.
- [ ] `teamKills == Σ player kills` at every checkpoint.
- [ ] **Zero** fabricated null-killer KILL events.
- [ ] **Zero** duplicate events (idempotency held).
- [ ] Game isolation: a new game did not inherit prior state.
- [ ] Persistence succeeded (rows present, versions monotonic).
- [ ] Objectives: plausible counts + correct sub-region/team mapping.
- [ ] Crystal destruction → `GAME_FINISHED` **when actually observed**; normal
      post-finish updates rejected.
- [ ] (If AI observer on) AI readings recorded as observations, graded through
      the same validators; no AI value overwrote confirmed state directly.

> These checkboxes are ticked from **persisted real-match evidence**, not from
> `npm test`.

---

## Failure triage (slide 40)

| Symptom | Likely layer |
|---|---|
| Blank crop | capture / calibration |
| Raw present but normalization rejected | preprocessing / normalization |
| Normalized but held (candidate) | game-logic / suspicious value |
| Accepted but wrong downstream | persistence / reducer / reconciliation |
| AI empty | inspect raw model request/response before touching business logic |

---

## Rollback

Every layer is a single env/localStorage flip:

- Public cutover regressed → `RECONSTRUCTION_PUBLIC_READS=0` (legacy-derived
  contract, no redeploy).
- Persistence noisy/incorrect → `RECONSTRUCTION_PERSISTENCE=0` (ingest no-ops).
- AI observer noisy → `RECONSTRUCTION_AI_OBSERVER` unset.
- Shadow entirely off → clear the `livevival:shadow*` localStorage keys.
