-- Minimal error log for automated video-metadata extraction (currently just
-- YouTube oEmbed title/author lookup in app/api/youtube-title, used from
-- the streams admin page). There was previously no record of these
-- failures anywhere — they just silently returned an error to the browser
-- and vanished. This table gives the admin dashboard something real to
-- report ("N failed extractions this week") instead of fabricated data.
-- Kept deliberately small: no retry/backoff machinery, just a timestamped
-- record of what failed and why.
create table if not exists extraction_failures (
  id uuid primary key default gen_random_uuid(),
  -- 'youtube_title' today; kept open-ended (not a check constraint) so a
  -- future thumbnail-extraction path can log into the same table without
  -- a migration.
  kind text not null,
  source_url text,
  match_id uuid references matches(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists extraction_failures_created_at_idx on extraction_failures (created_at desc);

alter table extraction_failures enable row level security;

-- The route that logs failures (app/api/youtube-title) runs server-side
-- with only the anon key (this deployment has no service-role credential
-- for API routes — see app/api/push/subscribe for the same constraint),
-- so it needs to insert as anon/authenticated. Same public-insert pattern
-- already used for push_subscriptions.
create policy "Anyone can log an extraction failure"
  on extraction_failures for insert
  to anon, authenticated
  with check (true);

-- Only admins read the log (surfaced on the admin dashboard).
create policy "Admins can read extraction failures"
  on extraction_failures for select
  to authenticated
  using (is_admin());
