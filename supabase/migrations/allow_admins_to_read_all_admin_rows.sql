-- The only existing SELECT policy on admins ("read own admin row",
-- user_id = auth.uid()) means the Manage Admins page's client-side query
-- (supabase.from("admins").select(...), running under RLS with the caller's
-- own session) only ever returns the signed-in admin's own row — every
-- other admin is silently filtered out, with no error surfaced (see
-- app/admin/manage-admins/page.tsx's loadAll(), which has no error
-- handling on that query). Mutations (create/delete/change role) already
-- go through service-role API routes and are unaffected; this is purely
-- about the listing view.
--
-- Mirrors the existing contributors_admin_all policy: any admin (via the
-- same is_admin() SECURITY DEFINER helper already used everywhere else)
-- can read the full admins table. Additive alongside the existing
-- self-read policy — Postgres OR's multiple permissive policies for the
-- same command, so this only widens access, never narrows it.
create policy "admins_read_all"
  on public.admins
  for select
  to authenticated
  using (is_admin());
