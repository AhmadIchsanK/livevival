-- Part of the "keep team/hero/player data always up to date" pass: extends
-- how much of each Liquipedia infobox we capture, and adds the plumbing
-- needed to re-check already-scraped rows periodically without silently
-- clobbering an admin's manual correction.
--
-- Values/types below were confirmed against real rendered pages (ONIC,
-- Ling, Kairi) via a throwaway diagnostic dispatch, not guessed:
--   - teams "created" is a clean ISO date ("2018-07-26"); "approx. total
--     winnings" is a dollar-formatted string ("$2,651,695").
--   - heroes "price" concatenates a Battle Points icon+number and a
--     Diamond icon+number with no separator in plain text — split into
--     two columns rather than one ambiguous field. "specialty" and
--     "voice actor(s)" concatenate multiple <br>-separated values the
--     same way "stage" labels did before (see deriveStageFromBracket's
--     fix) — stored as arrays. "release date" on this hero is only a bare
--     year ("2019"), not a full date, so it's an integer, not a date
--     column. "win rate" is a compound string ("2196W : 2139L (50.66%)")
--     — kept as both the parsed percentage (sortable/filterable) and the
--     raw W/L record text (not worth parsing further).
--   - players "born" includes a computed age suffix ("September 21, 2005
--     (age 20)") that needs stripping before date-parsing. "signature
--     heroes" has no direct text at all (icon-only cell) — must be read
--     via each icon anchor's title attribute, same pattern already used
--     for team names in bracket popups.
--   - player "team" (their own page's Team: field) is deliberately NOT
--     captured as a column — team_id is already derived from the more
--     authoritative team roster table, and a player's own page field
--     lags behind actual roster moves just as often as the roster table
--     does, so storing both risks disagreeing with itself. Same reasoning
--     for player "role" already being sourced from the roster table.

alter table teams add column if not exists founded_date date;
alter table teams add column if not exists total_winnings numeric;

alter table heroes add column if not exists price_bp integer;
alter table heroes add column if not exists price_diamond integer;
alter table heroes add column if not exists specialty text[];
alter table heroes add column if not exists resource_bar text;
alter table heroes add column if not exists voice_actors text[];
alter table heroes add column if not exists hp integer;
alter table heroes add column if not exists hp_regen numeric;
alter table heroes add column if not exists energy integer;
alter table heroes add column if not exists energy_regen numeric;
alter table heroes add column if not exists physical_attack integer;
alter table heroes add column if not exists physical_defense integer;
alter table heroes add column if not exists magic_power integer;
alter table heroes add column if not exists magic_defense integer;
alter table heroes add column if not exists attack_speed numeric;
alter table heroes add column if not exists attack_speed_ratio numeric;
alter table heroes add column if not exists movement_speed integer;
alter table heroes add column if not exists win_rate_pct numeric;
alter table heroes add column if not exists win_rate_record text;
alter table heroes add column if not exists release_year integer;
alter table heroes add column if not exists abilities jsonb;

alter table players add column if not exists born_date date;
alter table players add column if not exists status text;
alter table players add column if not exists alternate_ids text[];
alter table players add column if not exists nicknames text[];
alter table players add column if not exists total_winnings numeric;
alter table players add column if not exists signature_heroes text[];

-- Tracks when a scraper last confirmed a row against Liquipedia, whether
-- or not anything actually changed — activity_log only gets an entry when
-- a value *changes*, so it can't answer "was this row re-checked recently"
-- on its own. Drives the periodic-refresh cadence (see script header
-- comments) independently of the existing null-gap-fill pass.
alter table teams add column if not exists last_liquipedia_sync_at timestamptz;
alter table heroes add column if not exists last_liquipedia_sync_at timestamptz;
alter table players add column if not exists last_liquipedia_sync_at timestamptz;

-- activity_log has grown past 500k rows (matches/games churn heavily) with
-- only its primary key indexed. The new provenance check queries it by
-- (table_name, row_id) on every periodic re-scrape of an already-complete
-- team/hero/player row — without this index that's a full table scan per
-- row.
create index if not exists idx_activity_log_table_row_changed
  on activity_log (table_name, row_id, changed_at desc);
