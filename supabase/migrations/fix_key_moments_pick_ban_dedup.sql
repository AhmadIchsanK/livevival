-- key_moments_dedup was silently dropping every pick/ban past the first of
-- each type per game: minute_mark defaults to 0 during Draft (no game
-- clock runs yet), so the partial unique index (game_id, type, minute_mark)
-- where source='auto' allowed only one auto 'pick' row and one auto 'ban'
-- row per game before every subsequent insert started hitting the unique
-- violation (silently swallowed — the insert's error was never read).
-- Picks/bans don't need this dedup at all: hero_picks_bans already has its
-- own dedup on (game_id, team_id, hero_name, type), so key_moments logging
-- of them is a 1:1 mirror, never a re-detection of the same event.
drop index if exists key_moments_dedup;

create unique index if not exists key_moments_dedup
  on key_moments (game_id, type, minute_mark)
  where source = 'auto' and type not in ('pick', 'ban');
