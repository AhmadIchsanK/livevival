import { NextRequest, NextResponse } from "next/server";

// Uses YouTube's free, keyless oEmbed endpoint — no API key or quota needed.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not fetch video info — check that the URL is a valid, public YouTube video." },
        { status: 400 }
      );
    }
    const data = await res.json();
    return NextResponse.json({ title: data.title as string, author: data.author_name as string });
  } catch {
    return NextResponse.json({ error: "Failed to reach YouTube." }, { status: 500 });
  }
}
