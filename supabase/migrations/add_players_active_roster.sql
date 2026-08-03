-- Draft can't start until each team has exactly 5 active-roster players
-- (per the live console's new handlePhaseChange guard) — today `players`
-- has no active/bench distinction at all (team_id alone was "the roster"),
-- which silently broke slot math (slotPlayer/roleIndex-based ordering)
-- for any team with more than 5 rows. Defaults to true so every existing
-- player stays counted as active with no backfill needed.
alter table players add column if not exists is_active_roster boolean not null default true;
