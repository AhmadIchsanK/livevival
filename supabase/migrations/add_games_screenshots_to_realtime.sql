-- game_screenshots and games were never added to the supabase_realtime
-- publication, so the public match page's postgres_changes subscriptions
-- on those two tables silently matched nothing — screenshots only ever
-- appeared after a manual refresh (or incidentally, when some other
-- subscribed table's row happened to change around the same time and
-- triggered a full loadAll()). Every other table the live console writes
-- to (matches, games' sibling tables hero_picks_bans/player_stats/
-- objectives/key_moments/net_worth_snapshots) was already in the
-- publication; games and game_screenshots were the two gaps.
do $$ begin
  alter publication supabase_realtime add table games;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table game_screenshots;
exception when duplicate_object then null; end $$;
