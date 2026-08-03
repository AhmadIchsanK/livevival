-- Lets the admin panel offer a real Auto (Liquipedia) vs Manual choice per
-- game's VOD link. Without this, games.vod_url is a single column the
-- scraper (import-finished-match-details.mjs, via the refresh cron) always
-- overwrites on every run — any manual admin edit would silently get
-- clobbered the next time the cron fires. 'auto' (the default) means the
-- scraper is free to keep syncing vod_url from Liquipedia; 'manual' means
-- an admin has set it explicitly and the scraper must leave it alone.
alter table games add column if not exists vod_url_source text not null default 'auto';
do $$ begin
  alter table games add constraint games_vod_url_source_check check (vod_url_source in ('auto', 'manual'));
exception when duplicate_object then null; end $$;
