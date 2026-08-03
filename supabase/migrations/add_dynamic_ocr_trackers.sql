-- Generalizes capture_regions from a hardcoded CaptureField union baked
-- into app code into a data-driven "tracker" model: which (phase, category,
-- variable) combinations exist for a match is now admin-configurable rather
-- than a compile-time array, per the "add/edit/remove tracker per phase"
-- redesign. `field` becomes a freeform variable key (e.g. "kda_left_3",
-- "objective_left_tower") instead of a fixed TypeScript union member; the
-- new `phase`/`category`/`label` columns give each row the context that
-- used to live only in the app's PHASE_CAPTURE_FIELDS/CAPTURE_FIELDS
-- constants.

alter table capture_regions add column if not exists phase text;
alter table capture_regions add column if not exists category text;
alter table capture_regions add column if not exists label text;

-- Backfill existing calibrated rows using the same field->phase/category
-- mapping the old hardcoded CAPTURE_FIELDS/PHASE_CAPTURE_FIELDS arrays
-- encoded, so pre-existing calibration isn't lost.
update capture_regions set phase = 'MATCH_NOT_STARTED', category = 'countdown', label = 'Pre-game countdown'
  where field = 'countdown' and phase is null;
update capture_regions set phase = 'DRAFT_STARTED', category = 'draft_timer', label = 'Draft timer — Team A'
  where field = 'draft_timer_a' and phase is null;
update capture_regions set phase = 'DRAFT_STARTED', category = 'draft_timer', label = 'Draft timer — Team B'
  where field = 'draft_timer_b' and phase is null;
update capture_regions set phase = 'DRAFT_STARTED', category = 'draft_pick_team_block', label = 'Draft picks — left side (legacy team-block)'
  where field = 'draft_picks_left' and phase is null;
update capture_regions set phase = 'DRAFT_STARTED', category = 'draft_pick_team_block', label = 'Draft picks — right side (legacy team-block)'
  where field = 'draft_picks_right' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'game_timer', label = 'Game timer'
  where field = 'game_timer' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'objective', label = 'Objectives — left (legacy combined)'
  where field = 'objectives_left' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'objective', label = 'Objectives — right (legacy combined)'
  where field = 'objectives_right' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'net_worth', label = 'Net worth — left'
  where field = 'networth_left' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'net_worth', label = 'Net worth — right'
  where field = 'networth_right' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'player_kda',
    label = 'K/D/A — left #' || right(field, 1)
  where field like 'kda_left_%' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'player_kda',
    label = 'K/D/A — right #' || right(field, 1)
  where field like 'kda_right_%' and phase is null;
update capture_regions set phase = 'GAME_STARTED', category = 'kill_banner', label = 'Kill banner (Savage/Maniac/etc.)'
  where field = 'kill_banner' and phase is null;
update capture_regions set phase = 'GAME_FINISHED', category = 'victory_banner', label = 'Victory/defeat banner'
  where field = 'victory_banner' and phase is null;
update capture_regions set phase = 'TECHNICAL_PAUSE', category = 'pause_word', label = 'Pause indicator'
  where field = 'pause_word' and phase is null;
-- overlay_hint rows are text-only (no crop coords) and were never scoped to
-- one phase — keep them phase-independent under a dedicated marker.
update capture_regions set phase = 'ANY', category = 'overlay_hint', label = 'Overlay hint'
  where field = 'overlay_hint' and phase is null;
-- Safety net for anything unmapped above (shouldn't happen against real data).
update capture_regions set phase = coalesce(phase, 'CUSTOM'), category = coalesce(category, 'custom'), label = coalesce(label, field)
  where phase is null or category is null;

alter table capture_regions alter column phase set not null;
alter table capture_regions alter column category set not null;

-- Old uniqueness was (match_id, field) / (tournament_id, field) globally —
-- fine when each field name implicitly belonged to exactly one phase by
-- hardcoded convention, but the new model allows the same variable key to
-- exist under two different phases on purpose (rare, but not a bug), while
-- still blocking a literal duplicate tracker within one phase — the actual
-- "prevent multiple similar tracker ID for the same phase" requirement.
drop index if exists capture_regions_match_field_key;
drop index if exists capture_regions_match_field_uq;
drop index if exists capture_regions_tournament_field_uq;
create unique index if not exists capture_regions_match_phase_field_uq
  on capture_regions(match_id, phase, field) where match_id is not null;
create unique index if not exists capture_regions_tournament_phase_field_uq
  on capture_regions(tournament_id, phase, field) where tournament_id is not null;

-- Direct OCR'd team-kill counts, per the "team kill individual tracker per
-- team" request. Nullable: null means "no direct read yet, fall back to
-- summing player_stats.kills for that team" (today's only source); once
-- OCR (or a manual edit) sets a value here, it's shown instead of the sum —
-- confirmed with the site owner this override behavior is what's wanted,
-- not a side-by-side reference display.
alter table games add column if not exists team_a_kills_override int;
alter table games add column if not exists team_b_kills_override int;
