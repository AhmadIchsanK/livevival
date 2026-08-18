-- Per-match custom map conditions. The games.map field is free text with a few
-- built-in presets (Expanding Rivers / Flying Cloud / Dangerous Grass / Broken
-- Walls); admins asked to add their own map-condition labels that appear in the
-- map picker for ONE specific match only (not globally), and to edit/delete
-- them. Each row is a custom label scoped to a match; setting a game's map to
-- one still just writes games.map as before — this table only remembers the
-- custom labels so they can be reused across that match's games and managed.
create table if not exists public.match_map_conditions (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  unique (match_id, label)
);

create index if not exists idx_match_map_conditions_match_id on public.match_map_conditions(match_id);

alter table public.match_map_conditions enable row level security;

-- Public read (the map label is shown on public match pages); admin-only write.
drop policy if exists map_conditions_public_read on public.match_map_conditions;
create policy map_conditions_public_read on public.match_map_conditions
  for select using (true);

drop policy if exists map_conditions_admin_write on public.match_map_conditions;
create policy map_conditions_admin_write on public.match_map_conditions
  for all using (public.is_admin()) with check (public.is_admin());
