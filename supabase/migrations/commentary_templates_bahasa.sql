-- Bilingual auto-commentary templates. `template` stays the English text;
-- `template_id` holds the Bahasa Indonesia version (nullable — the engine falls
-- back to English when it's empty). The engine picks the column by the viewer's
-- selected language (see lib/matchCommentary.ts commentaryCandidates()).
-- Indonesian copy for the seeded rows is populated separately (a data update),
-- and the AI auto-improve tool now generates both languages for new lines.
ALTER TABLE public.commentary_templates
  ADD COLUMN IF NOT EXISTS template_id text;
