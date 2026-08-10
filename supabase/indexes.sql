-- Performance optimization indexes for Phases 2-4
-- Run these in Supabase SQL Editor to improve query performance

-- Phase 2: Query Performance Optimization Indexes

-- Matches table - frequently filtered by status and scheduled_at
CREATE INDEX IF NOT EXISTS idx_matches_status
ON matches(status);

CREATE INDEX IF NOT EXISTS idx_matches_scheduled_at
ON matches(scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_tournament_id
ON matches(tournament_id);

CREATE INDEX IF NOT EXISTS idx_matches_status_scheduled
ON matches(status, scheduled_at DESC);

-- Tournaments table - reference lookups
CREATE INDEX IF NOT EXISTS idx_tournaments_tier
ON tournaments(tier);

-- Games table - match queries
CREATE INDEX IF NOT EXISTS idx_games_match_id
ON games(match_id);

CREATE INDEX IF NOT EXISTS idx_games_status
ON games(match_id, status);

-- Key moments/objectives
CREATE INDEX IF NOT EXISTS idx_key_moments_match_id
ON key_moments(match_id);

CREATE INDEX IF NOT EXISTS idx_key_moments_game_id
ON key_moments(game_id);

-- Teams and players (for roster lookups)
CREATE INDEX IF NOT EXISTS idx_teams_name
ON teams(name);

CREATE INDEX IF NOT EXISTS idx_players_team_id
ON players(team_id);

-- Screenshots (for live capture galleries)
CREATE INDEX IF NOT EXISTS idx_screenshots_match_id
ON screenshots(match_id);

CREATE INDEX IF NOT EXISTS idx_screenshots_game_id
ON screenshots(game_id);

CREATE INDEX IF NOT EXISTS idx_screenshots_created_at
ON screenshots(game_id, created_at DESC);

-- Streams (for availability checks)
CREATE INDEX IF NOT EXISTS idx_streams_match_id
ON streams(match_id);

-- Statistics for live updates
CREATE INDEX IF NOT EXISTS idx_stats_game_id
ON stats(game_id);

CREATE INDEX IF NOT EXISTS idx_stats_player_id
ON stats(player_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_matches_upcoming
ON matches(status, scheduled_at)
WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_matches_live_with_tournament
ON matches(status, tournament_id)
WHERE status IN ('live', 'draft_started', 'game_started');

-- Phase 3: Monitoring and Analytics Indexes

-- For metrics and analytics queries
CREATE INDEX IF NOT EXISTS idx_matches_created_at
ON matches(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_games_created_at
ON games(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_state_history
ON matches(id, status, updated_at);

-- Phase 4: Advanced Caching Support

-- For cache invalidation coordination
CREATE INDEX IF NOT EXISTS idx_matches_last_modified
ON matches(updated_at DESC)
INCLUDE (status, tournament_id);

-- For predictive loading by state
CREATE INDEX IF NOT EXISTS idx_matches_state_transition
ON matches(status, scheduled_at)
WHERE status IN ('draft_started', 'draft_complete', 'game_started');

-- Optimizations for the public API endpoints
CREATE INDEX IF NOT EXISTS idx_matches_public_query
ON matches(status, scheduled_at)
INCLUDE (id, tournament_id, format);

-- Index for admin cache operations
CREATE INDEX IF NOT EXISTS idx_matches_cache_aware
ON matches(id, status, updated_at)
INCLUDE (tournament_id, team_a_id, team_b_id);

-- Verify indexes were created
-- Run this query to see all indexes:
-- SELECT indexname FROM pg_indexes WHERE tablename = 'matches' ORDER BY indexname;
