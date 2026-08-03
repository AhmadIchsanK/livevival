// Livevival — one-time backfill: fetches the real YouTube title for every
// stream row that's still stuck at the default overlay_template, using the
// same keyless oEmbed endpoint /api/youtube-title already uses for streams
// added by hand through the admin UI. Existing rows added before that
// on-blur auto-fill existed (or added any other way that skips it) never
// got a title — this closes that gap in one pass instead of one at a time.
//
// Not a recurring workflow: this is dispatched manually once. New streams
// keep getting titled automatically via the existing admin-page flow.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function videoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function fetchTitle(id) {
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  try {
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const { data: streams, error } = await supabase
    .from("streams")
    .select("id, url, overlay_template")
    .or("overlay_template.is.null,overlay_template.eq.default");
  if (error) throw error;

  console.log(`${streams.length} untitled stream(s) to process`);

  // Cache by video id — many rows are the same underlying video at
  // different ?t= timestamps, no need to look each one up separately.
  const titleCache = new Map();
  let updated = 0;
  let skipped = 0;

  for (const s of streams) {
    const id = videoId(s.url);
    if (!id) {
      skipped++;
      continue;
    }
    if (!titleCache.has(id)) {
      titleCache.set(id, await fetchTitle(id));
      await new Promise((r) => setTimeout(r, 200)); // light pacing, not documented but polite
    }
    const title = titleCache.get(id);
    if (!title) {
      skipped++;
      continue;
    }
    const { error: updateErr } = await supabase
      .from("streams")
      .update({ overlay_template: title })
      .eq("id", s.id)
      .or("overlay_template.is.null,overlay_template.eq.default");
    if (updateErr) {
      console.error(`Failed to update stream ${s.id}:`, updateErr.message);
      skipped++;
    } else {
      updated++;
    }
  }

  console.log(`Done: ${updated} updated, ${skipped} skipped (no resolvable title — private/deleted/age-restricted video)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
