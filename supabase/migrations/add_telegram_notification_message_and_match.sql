-- Powers a public per-match "Telegram feed" endpoint (for the Rashid Slack
-- integration): telegram_notifications previously only logged
-- entity_type/entity_id/notification_type, never the actual message text
-- that was sent, and entity_id is polymorphic (sometimes a match id,
-- sometimes a game/key_moment id) so there was no direct way to query
-- "every notification sent for match X" in one shot. match_id gives a
-- single consistent key regardless of what the specific entity was;
-- message stores the literal text posted to Telegram so the feed can show
-- exactly what was sent, not a recomputed approximation.
alter table telegram_notifications add column if not exists message text;
alter table telegram_notifications add column if not exists match_id uuid references matches(id) on delete cascade;
create index if not exists telegram_notifications_match_id_idx on telegram_notifications (match_id, sent_at desc);

-- The existing telegram_notifications_admin_only policy (ALL, authenticated
-- + is_admin()) would make the anon-key-driven public per-match Telegram-
-- feed endpoint (app/api/telegram-feed/[matchId]/route.ts) silently return
-- zero rows via RLS even though the query itself succeeds. Telegram
-- messages were already broadcast publicly to a chat, so exposing
-- read-only access to rows tagged with a match_id isn't a new disclosure —
-- scoped to match_id is not null so nothing without a match association
-- is exposed by this policy.
do $$ begin
  create policy telegram_notifications_public_feed_read
    on telegram_notifications
    for select
    to anon, authenticated
    using (match_id is not null);
exception when duplicate_object then null; end $$;
