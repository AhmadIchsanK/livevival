-- AI Vision observer (spec §25-27): the AI frame-analysis route records
-- append-only evidence rows in game_observations under the calling admin's own
-- JWT (it has no service-role credential), after its own is_admin() check.
-- game_observations had only an admin SELECT policy, so those inserts were
-- silently denied by RLS. Add the matching admin INSERT policy. Evidence is
-- non-authoritative and admin-only to write; public clients still cannot read
-- or write it.
drop policy if exists observations_admin_insert on public.game_observations;
create policy observations_admin_insert on public.game_observations
  for insert with check (public.is_admin());
