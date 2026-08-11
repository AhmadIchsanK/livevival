-- ===========================================================================
-- LIVEVIVAL — Game-State Reconstruction Engine (v4.0) — additive migration
-- ===========================================================================
-- Migration strategy (spec §38): ADD new tables only. Nothing here alters or
-- drops an existing table, so applying it cannot break the live site and
-- rolling back is a plain DROP of these three tables. The existing games /
-- player_stats / objectives / net_worth_snapshots / hero_picks_bans tables
-- remain the authoritative source until shadow-mode comparison (spec §39)
-- validates the reconstruction path and RECONSTRUCTION_PUBLIC_READS is flipped.
--
-- NOTE: This file is intentionally NOT auto-applied by the app. Apply it via
-- the Supabase SQL editor / migration tooling when you are ready to enable
-- RECONSTRUCTION_PERSISTENCE. Until then the engine runs purely in-memory
-- (live shadow) and the public confirmed-state API derives its contract from
-- the existing legacy tables.
-- ===========================================================================

-- ── 1. Raw observations (append-only evidence) — spec §08 ──────────────────
-- Every OCR/vision reading is stored verbatim, independent from confirmed
-- state. raw_value is never overwritten with a normalized/corrected value.
create table if not exists game_observations (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  match_id      uuid references matches(id) on delete cascade,
  field         text not null,               -- ObservationField
  side          text,                        -- 'left' | 'right'
  team_id       uuid references teams(id),
  player_id     uuid references players(id),
  game_time_seconds integer,                 -- timer anchor (primary temporal ref)
  captured_at   timestamptz not null default now(),
  raw_value     text not null,               -- verbatim OCR text (audit)
  normalized_value jsonb,                     -- typed interpretation, may be null
  confidence    real,                        -- 0..1
  source        text not null default 'ocr', -- 'ocr' | 'vision' | 'admin' | 'replay'
  status        text not null default 'candidate' -- confirmed|candidate|rejected|missing
);
create index if not exists idx_game_observations_game on game_observations(game_id);
create index if not exists idx_game_observations_game_field on game_observations(game_id, field);
create index if not exists idx_game_observations_captured on game_observations(captured_at desc);

-- ── 2. Confirmed events (first-class, replayable) — spec §09 ────────────────
-- The authoritative history. Confirmed state is always rebuildable by replaying
-- these in order. event_id is a stable/idempotent app-computed id, so a
-- duplicate OCR frame cannot create a duplicate event (unique constraint).
create table if not exists game_events (
  id            uuid primary key default gen_random_uuid(),
  event_id      text not null,               -- deterministic id (dedup key)
  game_id       uuid not null references games(id) on delete cascade,
  match_id      uuid references matches(id) on delete cascade,
  seq           bigint,                      -- monotonic per-game sequence
  type          text not null,               -- EventType
  game_time_seconds integer,
  created_at    timestamptz not null default now(),
  payload       jsonb not null default '{}'::jsonb,
  source        text not null default 'ocr',
  confidence    real,
  status        text not null default 'confirmed', -- candidate|confirmed|rejected
  evidence      jsonb not null default '[]'::jsonb, -- observation ids
  unique (game_id, event_id)                 -- idempotency (spec §37)
);
create index if not exists idx_game_events_game on game_events(game_id, seq);
create index if not exists idx_game_events_game_time on game_events(game_id, game_time_seconds);

-- ── 3. Materialized confirmed snapshot (fast public reads) — spec §10, §26 ─
-- One row per game holding the reduced confirmed state as JSON plus a monotonic
-- state_version for reconnect/missed-update detection. Derived data only — can
-- always be repaired by replaying game_events.
create table if not exists confirmed_game_state (
  game_id       uuid primary key references games(id) on delete cascade,
  match_id      uuid references matches(id) on delete cascade,
  status        text not null default 'not_started',
  state_version bigint not null default 0,
  timer_seconds integer not null default 0,
  state         jsonb not null default '{}'::jsonb, -- full PublicGameState
  updated_at    timestamptz not null default now()
);
create index if not exists idx_confirmed_state_match on confirmed_game_state(match_id);

-- ── 4. Manual corrections audit (spec §23) ─────────────────────────────────
-- Every admin repair is also a MANUAL_CORRECTION row in game_events; this table
-- is a convenience audit view carrying the human context. History is never
-- silently overwritten (spec §23 guardrail).
create table if not exists game_state_corrections (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  event_id      text,                        -- links to game_events.event_id
  field         text not null,
  old_value     jsonb,
  new_value     jsonb,
  admin_id      uuid references admins(id),
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_corrections_game on game_state_corrections(game_id);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Public may READ confirmed state and confirmed events only. Raw observations
-- and candidate/rejected rows are internal (spec §12: never expose candidates
-- to public clients). Writes are service-role/admin only.
alter table game_observations   enable row level security;
alter table game_events         enable row level security;
alter table confirmed_game_state enable row level security;
alter table game_state_corrections enable row level security;

-- confirmed_game_state: public read.
drop policy if exists confirmed_state_public_read on confirmed_game_state;
create policy confirmed_state_public_read on confirmed_game_state
  for select using (true);

-- game_events: public may read confirmed events only.
drop policy if exists game_events_public_read_confirmed on game_events;
create policy game_events_public_read_confirmed on game_events
  for select using (status = 'confirmed');

-- observations + corrections: admin read only.
drop policy if exists observations_admin_read on game_observations;
create policy observations_admin_read on game_observations
  for select using (is_admin());
drop policy if exists corrections_admin_read on game_state_corrections;
create policy corrections_admin_read on game_state_corrections
  for select using (is_admin());

-- All writes go through the service-role key (bypasses RLS) from server routes;
-- no client-side insert/update policies are granted, so a browser client can
-- never write confirmed state directly (spec §41).
