-- Native Web Push subscriptions for the "follow" bell on match/tournament
-- pages — no login required to subscribe (Notification permission + a
-- PushManager subscription is the only gate), so this is a public
-- fan-facing table. RLS allows public INSERT only: the site never reads,
-- updates, or deletes rows from the client — it only ever writes once, at
-- subscribe time. The worker's send path (querying by entity, and pruning
-- subscriptions that come back 404/410 "gone" from the push service) uses
-- the service role key, which bypasses RLS entirely, so no SELECT/UPDATE/
-- DELETE policy is needed for that either.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  entity_type text not null check (entity_type in ('match', 'tournament')),
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  -- Re-tapping "follow" for the same match/tournament in the same browser
  -- re-subscribes the identical endpoint — upsert on this instead of
  -- accumulating duplicate rows that would each get a separate push.
  unique (endpoint, entity_type, entity_id)
);

-- The worker's send path looks up "everyone following this match" — this
-- is the only query shape push_subscriptions ever serves.
create index if not exists push_subscriptions_entity_idx on push_subscriptions (entity_type, entity_id);

alter table push_subscriptions enable row level security;

create policy "Public can subscribe to push notifications"
  on push_subscriptions for insert
  to anon, authenticated
  with check (true);
