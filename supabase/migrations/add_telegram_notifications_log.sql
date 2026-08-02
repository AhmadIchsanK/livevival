-- Idempotency log for Telegram notifications — the worker and admin UI
-- both fire-and-forget POST to Telegram's Bot API, and this table's
-- unique constraint is what stops the same event (e.g. "match X went
-- live") from being announced twice across repeated poll ticks or
-- overlapping code paths, without needing extra state columns on
-- matches/games themselves.
--
-- Applied directly to the live project via the Supabase MCP connector;
-- mirrored here so schema.sql/migrations stay the source of truth for a
-- fresh setup.
create table if not exists public.telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null, -- 'match' | 'game' | 'key_moment'
  entity_id uuid not null,
  notification_type text not null, -- 'match_live' | 'match_finished' | 'game_result' | 'match_reminder' | 'draft_result' | 'key_moment'
  sent_at timestamptz not null default now(),
  unique (entity_type, entity_id, notification_type)
);

alter table public.telegram_notifications enable row level security;
create policy "telegram_notifications_admin_only" on public.telegram_notifications
  for all to authenticated using (is_admin()) with check (is_admin());
