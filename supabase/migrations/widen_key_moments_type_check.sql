-- moment_templates already had rows for type = 'double_kill', 'triple_kill',
-- and 'phase_notice' (the admin's "Log a moment" quick buttons), but the
-- key_moments CHECK constraint never included them — clicking any of those
-- three templates failed at the DB level with "violates check constraint
-- key_moments_type_check". Widened to match what the app actually needs to
-- log; additive only, no existing rows affected.
alter table public.key_moments drop constraint key_moments_type_check;
alter table public.key_moments add constraint key_moments_type_check
  check (type = ANY (ARRAY[
    'savage'::text, 'maniac'::text, 'double_kill'::text, 'triple_kill'::text,
    'lord_steal'::text, 'turtle_steal'::text, 'ace'::text,
    'phase_change'::text, 'phase_notice'::text,
    'game_finish'::text, 'match_finish'::text, 'game_pause'::text,
    'pick'::text, 'ban'::text, 'custom'::text, 'game_timestamp'::text
  ]));
