-- net_worth_snapshots had no timestamp, so "latest net worth" (the last row by
-- minute_mark) was ambiguous when several rows shared a minute — the displayed
-- value could lag the newest read. Add created_at + an index so consumers can
-- order by actual insert time and always show the most recent reading.
ALTER TABLE public.net_worth_snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_net_worth_snapshots_game_created ON public.net_worth_snapshots (game_id, created_at);
