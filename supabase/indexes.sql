-- Performance optimization indexes for Phases 2-4
-- Run these in Supabase SQL Editor to improve query performance
-- Note: Safe to run - only creates indexes on tables that exist in your schema

-- Matches table - frequently filtered by status and scheduled_at
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_scheduled_at ON matches(scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_tournament_id ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_status_scheduled ON matches(status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_upcoming ON matches(status, scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_matches_live_with_tournament ON matches(status, tournament_id) WHERE status IN ('live', 'draft_started', 'game_started');
CREATE INDEX IF NOT EXISTS idx_matches_created_at ON matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_state_history ON matches(id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_matches_last_modified ON matches(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_state_transition ON matches(status, scheduled_at) WHERE status IN ('draft_started', 'draft_complete', 'game_started');
CREATE INDEX IF NOT EXISTS idx_matches_public_query ON matches(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_matches_cache_aware ON matches(id, status, updated_at);

-- Tournaments table - reference lookups
CREATE INDEX IF NOT EXISTS idx_tournaments_tier ON tournaments(tier);

-- Games table - match queries
CREATE INDEX IF NOT EXISTS idx_games_match_id ON games(match_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(match_id, status);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at DESC);

-- Key moments/objectives
CREATE INDEX IF NOT EXISTS idx_key_moments_match_id ON key_moments(match_id);
CREATE INDEX IF NOT EXISTS idx_key_moments_game_id ON key_moments(game_id);

-- Teams and players (for roster lookups)
CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);

-- Streams (for availability checks)
CREATE INDEX IF NOT EXISTS idx_streams_match_id ON streams(match_id);

-- Optional indexes (only created if tables exist)
DO $$
BEGIN
  -- Screenshots indexes (if table exists)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'screenshots') THEN
    CREATE INDEX IF NOT EXISTS idx_screenshots_match_id ON screenshots(match_id);
    CREATE INDEX IF NOT EXISTS idx_screenshots_created_at ON screenshots(created_at DESC);
  END IF;

  -- Stats indexes (if table exists)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stats') THEN
    CREATE INDEX IF NOT EXISTS idx_stats_match_id ON stats(match_id);
    CREATE INDEX IF NOT EXISTS idx_stats_hero ON stats(hero);
  END IF;

  RAISE NOTICE 'Optional table indexes created successfully';
END $$;

-- Verify indexes were created
-- SELECT indexname FROM pg_indexes WHERE tablename = 'matches' ORDER BY indexname;
