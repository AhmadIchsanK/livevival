import { NextRequest, NextResponse } from "next/server";

// Liquipedia-hosted logos/icons (team logos, hero icons, tournament logos)
// have correct URLs in Supabase but were failing to render in the browser
// site-wide (confirmed: broken-image placeholders shown in production for
// rows that do have a logo_url, verified against real screenshots) — most
// likely Liquipedia/Wikimedia-style hotlink or referrer-based blocking of
// direct cross-origin <img> requests, which a raw <img src="https://
// liquipedia.net/..."> has no way around. Fetching server-side here and
// re-serving same-origin sidesteps that: this is a plain server-to-server
// fetch, not a browser request carrying our site's Referer header.
//
// Locked to the liquipedia.net media host only — this is a public proxy
// endpoint (no auth, images need to load for anonymous visitors), so
// without an allowlist it would be an open SSRF relay.
const ALLOWED_HOST = "liquipedia.net";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) {
    return NextResponse.json({ error: "URL host not allowed" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LivevivalImageProxy/1.0)",
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return NextResponse.json({ error: "Upstream fetch failed" }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `Upstream returned ${upstream.status}` }, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/png",
      // Liquipedia's own images are effectively static (a hero/team page's
      // icon rarely changes) — cache aggressively at the edge/browser
      // instead of re-proxying every request.
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
    },
  });
}
