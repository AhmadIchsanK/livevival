-- Large expansion of the auto-commentary starter library (see
-- commentary_templates.sql, commentary_templates_seed_expand.sql, and
-- lib/matchCommentary.ts). Brings the editable DB library well past 100 lines
-- across every condition so the live Moment ticker stops repeating. Each line
-- uses only the placeholders its condition supplies (a line only fires on a
-- trigger that provides all of its placeholders — see renderTemplate). All of
-- these are editable/mutable/removable from /admin/commentary, and the AI
-- auto-improve tool there can keep growing the set.
INSERT INTO public.commentary_templates (condition, template) VALUES
  -- net_worth
  ('net_worth', '{lead} squeezing the life out of this, {diff} clear on gold.'),
  ('net_worth', 'The economy belongs to {lead} — {diff} to the good.'),
  ('net_worth', '{lead} banking the leads, up {diff} in net worth.'),
  ('net_worth', '{trail} can''t find the money — {lead} {diff} ahead.'),
  ('net_worth', 'A {diff} gold cushion for {lead}, and it keeps growing.'),
  ('net_worth', 'It''s a gold clinic from {lead} — {diff} in front.'),
  ('net_worth', '{trail} throwing everything at it, still {diff} behind on gold.'),
  ('net_worth', 'Net worth razor-thin — {trail} back within {diff}.'),
  ('net_worth', 'Look at that comeback — {trail} have shaved {closed} off the gap.'),
  ('net_worth', '{trail} refusing to die, {closed} of the deficit already gone.'),
  ('net_worth', 'The gold gap is evaporating — {trail} within {diff} now.'),
  ('net_worth', 'Every fight is funding {lead} — {diff} up and climbing.'),
  -- kills
  ('kills', '{lead} winning the scraps that matter, {hi}–{lo}.'),
  ('kills', 'The kill feed is all {lead}, {hi} to {lo}.'),
  ('kills', '{trail} bleeding out on the scoreboard, {lo}–{hi}.'),
  ('kills', 'A proper dust-up — {count} bodies hit the ground.'),
  ('kills', 'It''s erupted! {count} kills in a heartbeat.'),
  ('kills', '{scorer} snap up a pick to swing the numbers.'),
  ('kills', '{scorer} catch one out on the rotation.'),
  ('kills', 'Punch for punch, {hi}–{lo} and nobody flinching.'),
  ('kills', '{lead} landing the heavier blows, {hi}–{lo} on kills.'),
  ('kills', 'The fight breaks and {count} go down in the chaos.'),
  -- tower
  ('tower', 'Timber! {team} bring down another — {count} now.'),
  ('tower', '{team} keep prying the map open, {count} towers gone.'),
  ('tower', 'That structure''s gone — {team} up to {count}.'),
  ('tower', '{team} trade the pick for a tower, {count} banked.'),
  ('tower', '{leader} have the map in a vice, {hi} towers to {lo}.'),
  ('tower', 'Half the base is missing — {leader} lead {hi}–{lo} on structures.'),
  -- turtle
  ('turtle', '{team} pocket the Turtle, gold for the whole roster.'),
  ('turtle', 'Turtle down and it''s {team}''s — momentum with it.'),
  ('turtle', '{team} take the Turtle uncontested, easy value.'),
  ('turtle', 'Clean Turtle for {team} — buff and gold in the bank.'),
  -- lord
  ('lord', 'LORD secured by {team} — here comes the siege.'),
  ('lord', '{team} slay the Lord; the base is on notice.'),
  ('lord', 'Enormous — {team} have the Lord and the map pressure.'),
  ('lord', '{team} bank the Lord; this is their closing window.'),
  ('lord', 'Lord is dead and {team} own it. Game on the line.'),
  -- player_kda
  ('player_kda', '{player} running the show — {k}/{d}/{a} and rising.'),
  ('player_kda', 'Untouchable stretch from {player}: {k}/{d}/{a}.'),
  ('player_kda', '{player} into {ka} takedowns — a genuine problem.'),
  ('player_kda', 'The scoreline flatters no one but {player}: {k}/{d}/{a}.'),
  ('player_kda', '{player} everywhere on the map, {ka} involvements.'),
  ('player_kda', 'Statement game brewing from {player} — {k}/{d}/{a}.'),
  ('player_kda', '{player} making it look routine at {k}/{d}/{a}.'),
  -- win_prob
  ('win_prob', 'The model''s decided — {favored} at {pct}%.'),
  ('win_prob', '{favored} pulling clear on the read, {pct}%.'),
  ('win_prob', 'Odds hardening for {favored}, {pct}% to close it.'),
  ('win_prob', 'The needle swings toward {to} — this is the turn.'),
  ('win_prob', 'Momentum, and the numbers, moving to {to}.'),
  ('win_prob', '{favored} favourites now — {pct}% on the model.'),
  -- hero
  ('hero', '{player}''s {hero} is carving through everything.'),
  ('hero', 'That {hero} in {player}''s hands looks unfair right now.'),
  ('hero', '{player} has the {hero} humming — a menace every fight.'),
  ('hero', 'Draft-defining pick: {player} on the {hero}.'),
  ('hero', 'Nobody has an answer for {player}''s {hero}.'),
  -- general
  ('general', 'The tension in here is unreal — anyone''s game.'),
  ('general', 'You cannot look away from this one.'),
  ('general', 'Next play could crack the whole game open.'),
  ('general', 'Both benches are on their feet for this.'),
  ('general', 'A real chess match unfolding on the map.'),
  ('general', 'Whoever blinks first loses this.')
ON CONFLICT DO NOTHING;
