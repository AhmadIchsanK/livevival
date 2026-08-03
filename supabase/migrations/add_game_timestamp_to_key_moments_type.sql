-- The admin's own moment-templates page and TYPES list already include
-- "game_timestamp" ("The game now entering {timestamp} minutes") as a
-- loggable type, but key_moments_type_check never allowed it — every
-- attempt to log that moment failed the CHECK constraint. The insert's
-- error was also never surfaced in the UI (fixed separately in
-- app code), so it silently did nothing instead of showing an error,
-- which is why this looked like a broken {timestamp} substitution rather
-- than a rejected insert.
alter table key_moments drop constraint key_moments_type_check;
alter table key_moments add constraint key_moments_type_check
  check (type = ANY (ARRAY[
    'savage', 'maniac', 'lord_steal', 'turtle_steal', 'ace',
    'phase_change', 'game_finish', 'match_finish', 'game_pause',
    'pick', 'ban', 'custom', 'game_timestamp'
  ]::text[]));
