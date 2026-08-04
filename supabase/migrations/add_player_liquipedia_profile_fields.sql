-- Fields sourced from each player's Liquipedia profile
-- (https://liquipedia.net/mobilelegends/All_Players and their individual
-- pages) for the players-table rebuild: real name, nationality (up to two
-- country codes per the site-owner's own "2 country code as indicator"
-- spec — Liquipedia lists dual nationality for some players), and social
-- links as a flexible platform->url map rather than fixed columns since
-- the set of platforms varies per player.
alter table players add column if not exists real_name text;
alter table players add column if not exists country_codes text[];
alter table players add column if not exists links jsonb;
