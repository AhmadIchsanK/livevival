-- Livevival — consolidated schema
-- Safe to run repeatedly: existing tables/columns are left untouched,
-- new ones are added with IF NOT EXISTS.
--
-- This file documents the tables the app already relies on (inferred from
-- the queries in app/**) plus the additions needed for match automation:
--   - streams              (one livestream URL -> many matches)
--   - matches.state        (the MATCH_NOT_STARTED..STREAM_ENDED lifecycle)
--   - games.state          (per-game DRAFT_STARTED..GAME_FINISHED lifecycle)
--   - key_moments additions (screenshot_url, source, confidence, dedup)
--   - vision_detections    (raw log of what the worker saw, for debugging)

create extension if not exists pgcrypto;

-- ── Existing core tables (created if missing, so this file is a full bootstrap) ──

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
  overlay_template text not null default 'default',
  created_at timestamptz not null default now()
);

create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'moderator' check (role in ('super_admin', 'moderator'))
);

-- ── Streams: a single broadcast URL that can cover multiple matches ──

do $$ begin
  create type stream_platform as enum ('youtube', 'facebook', 'other');
exception when duplicate_object then null; end $$;

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

-- ── Matches ──

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

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id),
  team_a_id uuid references teams(id),
  team_b_id uuid references teams(id),
  format text not null default 'BO3',       -- BO1 / BO3 / BO5
  scheduled_at timestamptz,
  status text not null default 'scheduled', -- scheduled / live / finished (existing simple status)
  youtube_url text,                          -- kept for backwards compatibility
  current_game_number int not null default 1,
  created_at timestamptz not null default now(),

  -- new: automation
  state match_state not null default 'MATCH_NOT_STARTED',
  stream_id uuid references streams(id),
  series_winner_team_id uuid references teams(id),
  auto_managed boolean not null default true, -- false = admin has taken manual control
  liquipedia_match_key text                    -- e.g. "TeamA vs TeamB|2026-08-01" for schedule matching
);

alter table streams
  add constraint streams_current_match_fk
  foreign key (current_match_id) references matches(id) deferrable initially deferred;

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id),
  ign text not null,
  role text
);

-- ── Games (one row per game within a Bo1/Bo3/Bo5 series) ──

do $$ begin
  create type game_state as enum (
    'DRAFT_STARTED',
    'DRAFT_COMPLETE',
    'GAME_STARTED',
    'GAME_FINISHED'
  );
exception when duplicate_object then null; end $$;

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references matches(id) on delete cascade,
  game_number int not null default 1,
  status text not null default 'live', -- existing simple status
  created_at timestamptz not null default now(),

  -- new: automation
  state game_state not null default 'DRAFT_STARTED',
  winner_team_id uuid references teams(id),
  started_at timestamptz,
  finished_at timestamptz,
  unique (match_id, game_number)
);

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
  gold int not null default 0,
  unique (game_id, player_id)
);

create table if not exists objectives (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  team_id uuid references teams(id),
  type text not null, -- tower / lord / turtle / base
  minute_mark int
);

create table if not exists net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  minute_mark int not null,
  team_a_gold int not null default 0,
  team_b_gold int not null default 0
);

-- ── Key moments (savage / maniac / lord steal / ace / etc.) ──

create table if not exists key_moments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  match_id uuid references matches(id), -- denormalized for cheap "all moments for this match" queries
  type text not null,                    -- savage / maniac / lord_steal / turtle_steal / ace
  player_id uuid references players(id),
  minute_mark int,
  created_at timestamptz not null default now(),

  -- new: automation
  source text not null default 'manual' check (source in ('manual', 'auto')),
  confidence numeric,                    -- 0-1, Groq vision's self-reported confidence when source='auto'
  screenshot_url text,                   -- Supabase Storage public URL of the frame that triggered detection
  stream_timestamp_seconds int           -- offset into the stream when detected, for the "watch this moment" link
);

-- Prevent the worker from logging the same moment twice from consecutive frames.
create unique index if not exists key_moments_dedup
  on key_moments (game_id, type, minute_mark)
  where source = 'auto';

-- ── Vision detection log (debugging / tuning the Groq prompt over time) ──

create table if not exists vision_detections (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid references streams(id) on delete cascade,
  match_id uuid references matches(id),
  captured_at timestamptz not null default now(),
  detected_phase text,          -- raw phase string Groq returned, before mapping to match_state/game_state
  detected_payload jsonb,       -- full parsed JSON response for later inspection
  frame_url text                -- optional: uploaded frame, only kept for a rolling window
);

create index if not exists vision_detections_stream_idx on vision_detections (stream_id, captured_at desc);
