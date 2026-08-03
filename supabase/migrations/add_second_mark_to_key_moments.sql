-- In-game moment timestamps only ever stored whole minutes (minute_mark),
-- because the admin console's `minute` state itself is Math.floor(seconds/60)
-- with the seconds component discarded entirely. Adds a companion column so
-- the moment list can show MM:SS instead of just the minute — the admin
-- console already tracks full-second precision internally (OCR game_timer
-- reads MM:SS directly, the manual stopwatch counts real seconds), this
-- was just never persisted.
alter table key_moments add column if not exists second_mark int not null default 0;
