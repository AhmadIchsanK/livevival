-- A tournament's official YouTube channel, used to auto-match this
-- tournament's matches to that channel's public live/upcoming streams (see
-- app/api/admin/sync-tournament-youtube/route.ts) — a separate concept from
-- matches.youtube_url/streams.url, which are per-match/per-stream links.
-- Accepts any youtube.com channel URL shape (/channel/UC…, /@handle,
-- /user/Name, /c/Name) — the sync route resolves whichever shape is stored.
alter table tournaments
  add column if not exists youtube_channel_url text;
