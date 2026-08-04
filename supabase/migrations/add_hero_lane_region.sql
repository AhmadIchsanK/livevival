-- Adds lane and region metadata to heroes, scraped from Liquipedia's
-- Portal:Heroes page (role already exists). lane: in-game position (e.g.
-- EXP Lane, Mid Lane, Roam, Jungle, Gold Lane). region: the hero's
-- in-lore faction/homeland on the Land of Dawn (e.g. Moniyan Empire,
-- Abyss Order, Esperia) as documented on Liquipedia's hero infobox.
alter table public.heroes add column if not exists lane text;
alter table public.heroes add column if not exists region text;
