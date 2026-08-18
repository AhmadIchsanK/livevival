-- Usage tracking for the auto-commentary template library (see
-- lib/matchCommentary.ts and /admin/commentary). Each time the live console
-- actually posts a line rendered from a custom template, it bumps that row's
-- use_count / last_used_at. The admin page surfaces the count and offers a
-- "delete least-used" batch cleanup so the library (capped at 300 rows) can be
-- pruned of lines that never fire, keeping variety high without unbounded growth.
ALTER TABLE public.commentary_templates
  ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Atomic increment so concurrent live consoles can't clobber each other's
-- counts (use_count = use_count + 1 in the DB, not read-modify-write in JS).
-- SECURITY DEFINER + a narrow body: it only ever bumps a counter, so exposing
-- it to authenticated callers is safe, and it means the bump doesn't depend on
-- the caller holding write RLS on the table.
CREATE OR REPLACE FUNCTION public.bump_commentary_use(template_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.commentary_templates
  SET use_count = use_count + 1, last_used_at = now()
  WHERE id = template_id;
$$;

GRANT EXECUTE ON FUNCTION public.bump_commentary_use(uuid) TO anon, authenticated;
