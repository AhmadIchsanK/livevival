-- Auto-commentary template library — admin-editable caster lines for the live
-- Moment list (see lib/matchCommentary.ts and /admin/commentary). These merge
-- with the built-in phrasings shipped in code. RLS mirrors moment_templates:
-- admins write, everyone reads.
CREATE TABLE IF NOT EXISTS public.commentary_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition text NOT NULL,
  template text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.commentary_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commentary_templates_admin_write ON public.commentary_templates;
CREATE POLICY commentary_templates_admin_write ON public.commentary_templates
  FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS commentary_templates_public_read ON public.commentary_templates;
CREATE POLICY commentary_templates_public_read ON public.commentary_templates
  FOR SELECT TO public USING (true);

-- Starter custom lines (built-ins still ship in code; these show placeholder use).
INSERT INTO public.commentary_templates (condition, template) VALUES
  ('net_worth', '{lead} making this look effortless — {diff} up and climbing.'),
  ('kills', 'The {lead} are winning every skirmish, {hi}–{lo} on kills.'),
  ('lord', '{team} take the Lord — the base is under threat now.'),
  ('player_kda', '{player} is the story of this game: {k}/{d}/{a} and counting.'),
  ('win_prob', 'Statistically it''s slipping away from the other side — {favored} at {pct}%.')
ON CONFLICT DO NOTHING;
