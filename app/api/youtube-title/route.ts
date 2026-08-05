import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Anon key only — same constraint as the rest of this deployment's API
// routes (no service-role credential available server-side). The
// extraction_failures table's RLS explicitly allows anon INSERT for
// exactly this reason.
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function logFailure(url: string, errorMessage: string) {
  // Best-effort — logging the failure must never itself fail the request
  // or surface a second error to the admin filling out the streams form.
  await supabase
    .from("extraction_failures")
    .insert({ kind: "youtube_title", source_url: url, error_message: errorMessage })
    .then(
      () => {},
      () => {}
    );
}

// Uses YouTube's free, keyless oEmbed endpoint — no API key or quota needed.
// (This route never touches YOUTUBE_API_KEY — that env var only gates the
// worker's Data API v3 search fallbacks in youtubeStreamFallback.mjs /
// youtubeVodFallback.mjs, which no-op cleanly when it's unset. Nothing here
// can crash for lack of it.)
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  let res: Response;
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    res = await fetch(oembedUrl);
  } catch (err) {
    await logFailure(url, err instanceof Error ? err.message : "Failed to reach YouTube");
    return NextResponse.json({ error: "Failed to reach YouTube." }, { status: 502 });
  }

  if (!res.ok) {
    // oEmbed 404s for private/deleted/age-restricted/nonexistent videos and
    // 400s for a malformed url param — both mean "no usable metadata",
    // surfaced as one clear message rather than leaking the raw status.
    await logFailure(url, `oEmbed returned ${res.status}`);
    return NextResponse.json(
      { error: "Could not fetch video info — check that the URL is a valid, public YouTube video." },
      { status: 400 }
    );
  }

  // oEmbed's contract is a flat { title, author_name, ... } object, but
  // nothing guarantees YouTube always sends a well-formed body (empty
  // response, HTML error page served with a 200, a future schema change) —
  // parse and shape-check explicitly instead of trusting a bare `as string`
  // cast, so a malformed response surfaces as a clear error instead of
  // silently handing the caller `title: undefined`.
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    await logFailure(url, "Malformed JSON in oEmbed response");
    return NextResponse.json(
      { error: "YouTube returned an unexpected response — couldn't extract a title." },
      { status: 502 }
    );
  }

  const title = typeof data === "object" && data !== null ? (data as Record<string, unknown>).title : undefined;
  const authorName =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).author_name : undefined;

  if (typeof title !== "string" || !title.trim()) {
    await logFailure(url, "oEmbed response had no usable title");
    return NextResponse.json(
      { error: "YouTube didn't return a usable title for this video." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    title,
    author: typeof authorName === "string" ? authorName : undefined,
  });
}
