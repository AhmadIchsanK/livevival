-- Auto-commentary writes key_moments rows with source='auto_commentary', but
-- the source CHECK only allowed 'manual'/'auto', so every commentary insert
-- silently failed the constraint (and was swallowed by the caller's try/catch)
-- — which is why auto-commentary never appeared despite the engine, templates,
-- default-ON toggle, and periodic trigger all working correctly. Allow the
-- source the code actually writes.
ALTER TABLE public.key_moments DROP CONSTRAINT IF EXISTS key_moments_source_check;
ALTER TABLE public.key_moments
  ADD CONSTRAINT key_moments_source_check
  CHECK (source = ANY (ARRAY['manual'::text, 'auto'::text, 'auto_commentary'::text]));
