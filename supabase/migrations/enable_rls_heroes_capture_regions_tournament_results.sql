-- Supabase advisors flagged these three tables as having Row Level Security
-- disabled — fully readable/writable by anon and authenticated roles via
-- the public REST API, regardless of what the admin panel's own auth check
-- does client-side. Policies below mirror how each table is actually used:
--
-- heroes: public site renders hero icons/names next to every pick/ban
--   (anon key, no login) -> public read. Only the admin panel and the
--   Liquipedia import scripts (which use the service role key and so
--   bypass RLS entirely) should write.
-- tournament_results: shown on the public finished-tournament standings
--   page (anon key) -> public read. Writes are importer/admin only.
-- capture_regions: local-OCR calibration data for the admin's live
--   console — never read by the public site -> admin-only for both.

alter table public.heroes enable row level security;
alter table public.tournament_results enable row level security;
alter table public.capture_regions enable row level security;

create policy "heroes_public_read" on public.heroes
  for select
  to anon, authenticated
  using (true);

create policy "heroes_admin_write" on public.heroes
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());

create policy "tournament_results_public_read" on public.tournament_results
  for select
  to anon, authenticated
  using (true);

create policy "tournament_results_admin_write" on public.tournament_results
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());

create policy "capture_regions_admin_only" on public.capture_regions
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());
