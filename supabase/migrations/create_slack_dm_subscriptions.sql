-- Per-Slack-user opt-in/out for DM copies of channel notifications. No
-- Supabase auth relationship — slack_user_id is Slack's own user ID,
-- managed entirely by the /api/slack/events route via the service role
-- key. RLS enabled with no policies: only the service role can touch it.
create table if not exists slack_dm_subscriptions (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null unique,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table slack_dm_subscriptions enable row level security;
