-- storage.objects has RLS enabled but had ZERO policies for the
-- key-moment-screenshots and player-photos buckets — confirmed via
-- pg_policies (empty for storage.objects). RLS enabled + no policies is
-- deny-all for every operation, for every non-bypass role, on every
-- bucket, regardless of the bucket's own `public: true` flag (that flag
-- only affects unauthenticated GET via the public CDN URL, not
-- INSERT/UPDATE/DELETE via the storage API). This is why admin screenshot
-- capture failed with "new row violates row-level security policy" — it
-- was never actually working, not a regression. Player-photo upload was
-- likely silently broken the same way.
--
-- Public read is safe (and required — object GET via the API, as opposed
-- to the public CDN URL, also goes through these policies) since both
-- buckets are `public: true` and rendered on the public site. Writes are
-- admin-only via is_admin(), same pattern as heroes/tournament_results/
-- capture_regions in enable_rls_heroes_capture_regions_tournament_results.sql.

create policy "key_moment_screenshots_public_read" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'key-moment-screenshots');

create policy "key_moment_screenshots_admin_write" on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'key-moment-screenshots' and is_admin());

create policy "key_moment_screenshots_admin_update" on storage.objects
  for update
  to authenticated
  using (bucket_id = 'key-moment-screenshots' and is_admin())
  with check (bucket_id = 'key-moment-screenshots' and is_admin());

create policy "key_moment_screenshots_admin_delete" on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'key-moment-screenshots' and is_admin());

create policy "player_photos_public_read" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'player-photos');

create policy "player_photos_admin_write" on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'player-photos' and is_admin());

create policy "player_photos_admin_update" on storage.objects
  for update
  to authenticated
  using (bucket_id = 'player-photos' and is_admin())
  with check (bucket_id = 'player-photos' and is_admin());

create policy "player_photos_admin_delete" on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'player-photos' and is_admin());
