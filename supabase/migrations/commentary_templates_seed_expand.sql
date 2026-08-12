-- Expand the auto-commentary starter library (see commentary_templates.sql and
-- lib/matchCommentary.ts). ~30 additional caster lines across every condition,
-- each using only the placeholders its condition supplies (a line only fires on
-- a trigger that provides all of its placeholders — see renderTemplate). These
-- are all editable/mutable from /admin/commentary.
INSERT INTO public.commentary_templates (condition, template) VALUES
  ('net_worth', '{lead} turning the screw — {diff} clear and pulling away.'),
  ('net_worth', 'You can feel {trail} pressing, but {lead} still hold a {diff} edge.'),
  ('net_worth', 'Gold''s doing the talking: {lead} up {diff}.'),
  ('net_worth', '{trail} need a pick-off soon — {diff} is a lot to give back.'),
  ('net_worth', 'Huge swing — {trail} have wiped {closed} off the deficit.'),
  ('net_worth', 'Momentum''s real: {trail} clawing back, only {diff} in it now.'),
  ('kills', '{lead} winning the war of picks — {hi} to {lo}.'),
  ('kills', 'Every fight ends the same way: {lead} on top, {hi}–{lo}.'),
  ('kills', 'And it kicks off! {count} down in the blink of an eye.'),
  ('kills', 'Chaos across the map — {count} taken out in seconds.'),
  ('kills', '{scorer} find the opening and take one.'),
  ('kills', '{trail} can''t stop the bleeding, {lo} to {hi} on kills.'),
  ('tower', 'There goes another one — {team} on {count} towers.'),
  ('tower', '{team} keep marching, {count} structures down.'),
  ('tower', '{leader} have strangled the map, {hi} towers to {lo}.'),
  ('turtle', '{team} claim the Turtle — free gold for the squad.'),
  ('turtle', 'Cheeky one from {team}, Turtle secured.'),
  ('lord', 'LORD is dead — {team} have it, and here comes the siege.'),
  ('lord', '{team} bank the Lord; this is their window.'),
  ('lord', 'Massive call from {team} — Lord secured.'),
  ('player_kda', '{player} sitting pretty on {k}/{d}/{a}.'),
  ('player_kda', 'The scoreboard has {player} at {k}/{d}/{a}.'),
  ('player_kda', '{player} involved in {ka} takedowns already.'),
  ('win_prob', 'The numbers like {favored} — {pct}% and climbing.'),
  ('win_prob', '{favored} closing in; the model says {pct}%.'),
  ('win_prob', 'Feel that? The game is tilting toward {to}.'),
  ('hero', '{player} making the {hero} look broken right now.'),
  ('hero', 'That {hero} pick from {player} is paying off big.'),
  ('general', 'This one''s got everything — what a match.'),
  ('general', 'The crowd is on the edge of their seats here.'),
  ('general', 'Feels like the next play could decide everything.')
ON CONFLICT DO NOTHING;
