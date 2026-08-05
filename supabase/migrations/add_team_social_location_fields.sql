-- Social/website links and location/region metadata for teams, surfaced on
-- the public teams page (link icons under the team name) and used to power
-- region/location filtering. All nullable — existing teams have none of
-- this data yet and it's filled in by admins over time.
alter table public.teams add column if not exists website_url text;
alter table public.teams add column if not exists twitter_url text;
alter table public.teams add column if not exists instagram_url text;
alter table public.teams add column if not exists facebook_url text;
alter table public.teams add column if not exists youtube_url text;
alter table public.teams add column if not exists discord_url text;
alter table public.teams add column if not exists location text;
alter table public.teams add column if not exists region text;

comment on column public.teams.location is 'Free-text city/country, e.g. "Jakarta, Indonesia". Display detail only.';
comment on column public.teams.region is 'Coarser categorical grouping (e.g. "Indonesia", "Philippines", "MENA") used for the public teams-page region filter. Free text, not a fixed enum — filter options are derived from distinct values present in the data.';
