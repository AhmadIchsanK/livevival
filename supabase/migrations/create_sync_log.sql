-- Records every MANUAL Liquipedia sync an admin triggers from /admin/data-sync,
-- so "did anyone re-sync this, and when?" is answerable in-app instead of
-- digging through GitHub Actions history. Scheduled (cron) runs are NOT logged
-- here — those are visible in the Actions tab; this table is specifically the
-- audit trail for on-demand admin triggers (who, when, which tournaments).
create table if not exists public.sync_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  triggered_by text,                 -- admin's email (best-effort)
  workflow text not null,            -- 'tournaments' | 'details'
  tournament_slugs text,             -- comma-separated targets, or null = full pass
  status text not null,              -- 'dispatched' | 'error'
  detail text                        -- error text / short note
);

create index if not exists idx_sync_log_created_at on public.sync_log (created_at desc);

alter table public.sync_log enable row level security;

-- Admins read the audit trail; the trigger endpoint (running under the admin's
-- own JWT after an is_admin() check) writes its row.
drop policy if exists sync_log_admin_select on public.sync_log;
create policy sync_log_admin_select on public.sync_log
  for select using (public.is_admin());

drop policy if exists sync_log_admin_insert on public.sync_log;
create policy sync_log_admin_insert on public.sync_log
  for insert with check (public.is_admin());
