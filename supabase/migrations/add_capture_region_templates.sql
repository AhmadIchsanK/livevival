-- Named, reusable tracker layouts ("templates") — a third scope alongside
-- the existing per-match and per-tournament-default rows on
-- capture_regions. Lets an admin save a fully-calibrated layout from one
-- broadcast under a name (e.g. "MSC standard overlay") and apply it to
-- any future match/tournament, instead of every match starting from the
-- single hardcoded generic layout in defaultTrackerLayout().
alter table public.capture_regions
  add column template_name text;

alter table public.capture_regions
  drop constraint capture_regions_scope_check;

alter table public.capture_regions
  add constraint capture_regions_scope_check check (
    (match_id is not null and tournament_id is null and template_name is null) or
    (match_id is null and tournament_id is not null and template_name is null) or
    (match_id is null and tournament_id is null and template_name is not null)
  );

-- Mirrors the existing tournament_id,phase,field uniqueness the
-- tournament-default upsert already relies on (onConflict:
-- "tournament_id,phase,field") — same pattern, template scope.
create unique index capture_regions_template_scope_key
  on public.capture_regions (template_name, phase, field)
  where template_name is not null;
