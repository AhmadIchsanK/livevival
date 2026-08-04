-- Multi-tier admin/contributor system: Super Admin, Admin, Contributor.
--
-- Today `admins.role` is fetched and displayed but never actually branched
-- on anywhere — every RLS "admin write" policy just calls is_admin(),
-- which doesn't distinguish tiers. This migration:
--   1. Renames the unused 'moderator' role value to 'admin' (confirmed via
--      `select distinct role from admins` that 0 rows use 'moderator' —
--      the only existing row is 'super_admin') and locks the column to
--      exactly those two values.
--   2. Adds is_super_admin(), the same shape as the existing is_admin()
--      but scoped to the super_admin tier, for gating "Add Admin."
--   3. Adds `contributors` (public applicants, approved by an admin) and
--      `edit_requests` (a contributor's proposed change to any of the 6
--      entity types, or a bundled finished-match live-console correction
--      via entity_type='match_live_edit' — see app/admin/matches/[id]/live
--      /page.tsx's contributor-mode buffering).
--   4. Adds `activity_log` plus a generic log_activity() trigger attached
--      to every table that already has an "admin write" RLS policy (the
--      full list below, confirmed via `pg_policies`), so every core-data
--      mutation site-wide is captured automatically — including
--      admin-management and request-lifecycle events, since admins/
--      contributors/edit_requests get the same trigger.

-- 1. Role tiers -------------------------------------------------------

update public.admins set role = 'admin' where role = 'moderator';

alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins
  add constraint admins_role_check check (role in ('super_admin', 'admin'));

create or replace function public.is_super_admin()
  returns boolean
  language sql
  security definer
  set search_path to 'public'
as $$
  select exists (select 1 from admins where user_id = auth.uid() and role = 'super_admin');
$$;

-- 2. Contributors -------------------------------------------------------

create table public.contributors (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id),
  name text not null,
  social_platform text not null check (social_platform in ('instagram', 'facebook', 'x', 'threads')),
  social_handle text not null,
  email text not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  applied_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.admins(id),
  decision_note text
);

alter table public.contributors enable row level security;

-- A contributor applies by signing up with Supabase Auth client-side
-- (no service role needed) then inserting their own row — this policy is
-- what makes that self-registration possible.
create policy "contributors_self_insert" on public.contributors
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "contributors_self_read" on public.contributors
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "contributors_admin_all" on public.contributors
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- 3. Edit requests -------------------------------------------------------

create table public.edit_requests (
  id uuid primary key default uuid_generate_v4(),
  contributor_id uuid not null references public.contributors(id),
  entity_type text not null check (
    entity_type in ('tournament', 'team', 'player', 'hero', 'match', 'stream', 'match_live_edit')
  ),
  entity_id uuid,
  action text not null check (action in ('create', 'update')),
  proposed_changes jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references public.admins(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.edit_requests enable row level security;

create policy "edit_requests_contributor_insert" on public.edit_requests
  for insert
  to authenticated
  with check (
    exists (select 1 from public.contributors c where c.id = contributor_id and c.user_id = auth.uid())
  );

create policy "edit_requests_contributor_read" on public.edit_requests
  for select
  to authenticated
  using (
    exists (select 1 from public.contributors c where c.id = contributor_id and c.user_id = auth.uid())
  );

create policy "edit_requests_admin_all" on public.edit_requests
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());

-- 4. Site-wide activity log -------------------------------------------------------

create table public.activity_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id uuid,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  old_data jsonb,
  new_data jsonb,
  changed_at timestamptz not null default now()
);

alter table public.activity_log enable row level security;

-- Deliberately no insert/update/delete policy for anon/authenticated —
-- only log_activity() (security definer) writes here, so the audit trail
-- can't be tampered with by anything that goes through the normal RLS path.
create policy "activity_log_admin_read" on public.activity_log
  for select
  to authenticated
  using (is_admin());

create or replace function public.log_activity()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  insert into public.activity_log (table_name, row_id, operation, actor_id, old_data, new_data)
  values (
    TG_TABLE_NAME,
    coalesce((case when TG_OP = 'DELETE' then old.id else new.id end), null),
    TG_OP,
    auth.uid(),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

-- Every table that already has an "admin write" RLS policy (confirmed via
-- pg_policies against the live project), plus the three new tables above —
-- attaching it to admins/contributors/edit_requests means account-
-- management and request-lifecycle actions show up in the log for free.
do $$
declare
  t text;
begin
  foreach t in array array[
    'teams', 'players', 'matches', 'tournaments', 'streams', 'games',
    'hero_picks_bans', 'key_moments', 'player_stats', 'heroes', 'objectives',
    'net_worth_snapshots', 'tournament_results', 'capture_regions',
    'moment_templates', 'telegram_notifications', 'item_snapshots',
    'vision_detections', 'game_screenshots', 'admins',
    'contributors', 'edit_requests'
  ]
  loop
    execute format(
      'drop trigger if exists log_activity_trigger on public.%I; ' ||
      'create trigger log_activity_trigger after insert or update or delete on public.%I ' ||
      'for each row execute function public.log_activity();',
      t, t
    );
  end loop;
end $$;
