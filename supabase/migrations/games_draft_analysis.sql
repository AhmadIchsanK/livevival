-- AI draft analysis (spec: post-draft breakdown). After a game's draft is
-- complete, an admin action asks a text model which side's draft is stronger
-- (lane matchups, counters, composition) and an explicit win-probability split,
-- capped at two short paragraphs. The result is stored per game so both the
-- admin console and the public match page can render it below the scoreboard,
-- and it's also posted once to the moment feed. Nullable free text; no new RLS
-- needed (games already has public-read / admin-write policies).
alter table public.games add column if not exists draft_analysis text;
alter table public.games add column if not exists draft_analysis_at timestamptz;
