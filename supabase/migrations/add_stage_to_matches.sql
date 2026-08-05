-- Adds a free-text "stage" label to matches (e.g. "Group A", "Regular
-- Season", "Playoffs", "Grand Final", "Bracket Stage"). Kept as plain text
-- rather than an enum — tournament structures vary too much (round robin,
-- single/double elim, national league groups) to enumerate cleanly, the
-- same reasoning already applied to liquipedia_slug/tier elsewhere in this
-- schema. Nullable: most existing matches have no stage recorded yet, and
-- it stays optional going forward for tournaments with a single flat
-- schedule where a stage label would be redundant.
alter table public.matches add column if not exists stage text;
