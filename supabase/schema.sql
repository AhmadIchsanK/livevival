-- Livevival — consolidated schema (fixed for pre-existing tables)
-- Safe to run repeatedly, and safe against tables that ALREADY exist from
-- earlier phases (teams, tournaments, admins, matches, players, games,
-- hero_picks_bans, player_stats, objectives, net_worth_snapshots,
-- key_moments). New columns on those are added via explicit
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS — CREATE TABLE IF NOT EXISTS
-- alone does NOT add columns to a table that already exists, which is
-- what caused the "column source does not exist" error.

create extension if not exists pgcrypto;

-- ── Base tables (only created if this is a genuinely fresh project) ──

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text,
  created_at timestamptz not null default now()
);

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text not null default 'S',
  liquipedia_slug text unique,
  date_display text,
  created_at timestamptz not null default now()
);
alter table tournaments add column if not exists overlay_template text not null default 'default';

create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'moderator' check (role in ('super_admin', 'moderator'))
);

-- ── New enums ──

do $$ begin
  create type stream_platform as enum ('youtube', 'facebook', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type match_state as enum (
    'MATCH_NOT_STARTED',
    'DRAFT_STARTED',
    'DRAFT_COMPLETE',
    'GAME_STARTED',
    'GAME_FINISHED',
    'SERIES_FINISHED',
    'STREAM_ENDED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type game_state as enum (
    'DRAFT_STARTED',
    'DRAFT_COMPLETE',
    'GAME_STARTED',
    'GAME_FINISHED'
  );
exception when duplicate_object then null; end $$;

-- ── Streams (brand new table — one livestream URL, many matches) ──

create table if not exists streams (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  platform stream_platform not null default 'youtube',
  overlay_template text not null default 'default',
  tournament_id uuid references tournaments(id),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  current_match_id uuid,
  poll_interval_seconds int not null default 5,
  last_polled_at timestamptz,
  created_at timestamptz not null default now()
);

-- ── Matches (likely already exists — add columns individually) ──

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id),
  team_a_id uuid references teams(id),
  team_b_id uuid references teams(id),
  format text not null default 'BO3',
  scheduled_at timestamptz,
  status text not null default 'scheduled',
  youtube_url text,
  current_game_number int not null default 1,
  created_at timestamptz not null default now()
);

alter table matches add column if not exists state match_state not null default 'MATCH_NOT_STARTED';
alter table matches add column if not exists stream_id uuid references streams(id);
alter table matches add column if not exists series_winner_team_id uuid references teams(id);
alter table matches add column if not exists auto_managed boolean not null default true;
alter table matches add column if not exists liquipedia_match_key text;

-- FK from streams.current_match_id -> matches.id, added now that matches
-- definitely exists. Guarded so re-running this file doesn't error on a
-- duplicate constraint.
do $$ begin
  alter table streams
    add constraint streams_current_match_fk
    foreign key (current_match_id) references matches(id) deferrable initially deferred;
exception when duplicate_object then null; end $$;

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id),
  ign text not null,
  role text
);

-- ── Games (likely already exists — add columns individually) ──

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references matches(id) on delete cascade,
  game_number int not null default 1,
  status text not null default 'live',
  created_at timestamptz not null default now()
);

alter table games add column if not exists state game_state not null default 'DRAFT_STARTED';
alter table games add column if not exists winner_team_id uuid references teams(id);
alter table games add column if not exists started_at timestamptz;
alter table games add column if not exists finished_at timestamptz;

do $$ begin
  alter table games add constraint games_match_id_game_number_key unique (match_id, game_number);
exception when duplicate_object then null; end $$;

create table if not exists hero_picks_bans (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  team_id uuid references teams(id),
  hero_name text not null,
  type text not null check (type in ('pick', 'ban')),
  pick_order int
);

create table if not exists player_stats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  player_id uuid references players(id),
  hero_name text,
  kills int not null default 0,
  deaths int not null default 0,
  assists int not null default 0,
  gold int not null default 0
);

do $$ begin
  alter table player_stats add constraint player_stats_game_id_player_id_key unique (game_id, player_id);
exception when duplicate_object then null; end $$;

create table if not exists objectives (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  team_id uuid references teams(id),
  type text not null,
  minute_mark int
);

create table if not exists net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  minute_mark int not null,
  team_a_gold int not null default 0,
  team_b_gold int not null default 0
);

-- ── Key moments (likely already exists — add columns individually) ──

create table if not exists key_moments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  type text not null,
  player_id uuid references players(id),
  minute_mark int,
  created_at timestamptz not null default now()
);

alter table key_moments add column if not exists match_id uuid references matches(id);
alter table key_moments add column if not exists source text not null default 'manual';
do $$ begin
  alter table key_moments add constraint key_moments_source_check check (source in ('manual', 'auto'));
exception when duplicate_object then null; end $$;
alter table key_moments add column if not exists confidence numeric;
alter table key_moments add column if not exists screenshot_url text;
alter table key_moments add column if not exists stream_timestamp_seconds int;

-- Backfill match_id on any pre-existing rows so the dedup index and the
-- public match page's match_id-based queries work for older data too.
update key_moments km
set match_id = g.match_id
from games g
where km.game_id = g.id and km.match_id is null;

create unique index if not exists key_moments_dedup
  on key_moments (game_id, type, minute_mark)
  where source = 'auto';

-- ── Vision detection log (brand new table) ──

create table if not exists vision_detections (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid references streams(id) on delete cascade,
  match_id uuid references matches(id),
  captured_at timestamptz not null default now(),
  detected_phase text,
  detected_payload jsonb,
  frame_url text
);

create index if not exists vision_detections_stream_idx on vision_detections (stream_id, captured_at desc);

-- ── Additions for Liquipedia finished-match import (VOD + results + picks) ──

-- Per-game VOD link, since a Bo3/Bo5 series can have a different YouTube
-- link (or a timestamp offset into the same link) per game.
alter table games add column if not exists vod_url text;

-- draftTracking.mjs and the new finished-match importer both rely on
-- inserting the same pick repeatedly being a harmless no-op — this was
-- referenced in code comments but never actually added until now.
do $$ begin
  alter table hero_picks_bans
    add constraint hero_picks_bans_dedup unique (game_id, team_id, hero_name, type);
exception when duplicate_object then null; end $$;

-- ── Tournament final standings (place, prize money, and any extra points
-- columns a tournament's prizepool table includes) ──

create table if not exists tournament_results (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade,
  placement text not null,            -- "1", "2", or a tied range like "5-8"
  placement_sort int,                 -- numeric sort key (the range's lower bound)
  team_id uuid references teams(id),  -- null if Liquipedia still shows "TBD"
  team_name_raw text not null,
  prize_usd numeric,
  extra jsonb,                        -- any other columns (e.g. club championship points)
  created_at timestamptz not null default now()
);

create unique index if not exists tournament_results_dedup
  on tournament_results (tournament_id, placement, team_name_raw);
