import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Auto-matches a tournament's matches to its official YouTube channel's
// public live/upcoming streams: called from /admin/tournaments right after
// saving a tournament with youtube_channel_url set. Same admin-session auth
// pattern as /api/admin/refresh-liquipedia — a service-role key isn't
// configured in this deployment, so the caller's own Supabase session +
// is_admin() RPC gates this, not a shared secret.
//
// Best-effort, not a hard guarantee (same spirit as
// worker/src/youtubeStreamFallback.mjs): a match only gets filled when its
// scheduled_at falls on the same UTC calendar date as a found stream's
// scheduled/actual start time, and only when the match doesn't already
// have a youtube_url — this never overwrites a link someone already set.

type YoutubeVideoListItem = {
  id: string;
  liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string };
};

function extractChannelId(channelUrl: string): string | null {
  const m = channelUrl.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  return m ? m[1] : null;
}

function extractHandle(channelUrl: string): string | null {
  const m = channelUrl.match(/youtube\.com\/@([\w.-]+)/);
  return m ? `@${m[1]}` : null;
}

function extractLegacyUsername(channelUrl: string): string | null {
  const m = channelUrl.match(/youtube\.com\/user\/([\w-]+)/);
  return m ? m[1] : null;
}

function extractCustomName(channelUrl: string): string | null {
  const m = channelUrl.match(/youtube\.com\/c\/([\w-]+)/);
  return m ? m[1] : null;
}

// Resolves whatever shape of youtube.com channel URL was pasted into
// youtube_channel_url down to a canonical UC... channel ID — search.list
// and channels.list both need that, not a handle/username/custom name.
async function resolveChannelId(channelUrl: string, apiKey: string): Promise<string | null> {
  const direct = extractChannelId(channelUrl);
  if (direct) return direct;

  const handle = extractHandle(channelUrl);
  if (handle) {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("part", "id");
    url.searchParams.set("forHandle", handle);
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const id = data.items?.[0]?.id;
      if (id) return id;
    }
  }

  const legacyUsername = extractLegacyUsername(channelUrl);
  if (legacyUsername) {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("part", "id");
    url.searchParams.set("forUsername", legacyUsername);
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const id = data.items?.[0]?.id;
      if (id) return id;
    }
  }

  // Last resort for /c/CustomName URLs and anything else not resolvable
  // by a direct API parameter — a channel-type search on the same text.
  const query = extractCustomName(channelUrl) ?? channelUrl.split("youtube.com/").pop() ?? channelUrl;
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("key", apiKey);
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "channel");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("maxResults", "1");
  const res = await fetch(searchUrl);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0]?.snippet?.channelId ?? data.items?.[0]?.id?.channelId ?? null;
}

async function searchVideoIds(channelId: string, eventType: "live" | "upcoming", apiKey: string): Promise<string[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("eventType", eventType);
  url.searchParams.set("type", "video");
  url.searchParams.set("part", "id");
  url.searchParams.set("maxResults", "25");
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`YouTube channel search failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return (data.items ?? []).map((item: { id?: { videoId?: string } }) => item.id?.videoId).filter(Boolean);
}

async function fetchLiveStreamingDetails(videoIds: string[], apiKey: string): Promise<YoutubeVideoListItem[]> {
  if (videoIds.length === 0) return [];
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("part", "liveStreamingDetails");
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`YouTube videos.list failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return data.items ?? [];
}

function utcDateKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const tournamentId: string | undefined = body?.tournamentId;
  if (!tournamentId) {
    return NextResponse.json({ error: "tournamentId is required" }, { status: 400 });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Not configured — set YOUTUBE_API_KEY (a YouTube Data API v3 key) to enable stream auto-matching." },
      { status: 503 }
    );
  }

  const { data: tournament, error: tError } = await supabase
    .from("tournaments")
    .select("id, name, youtube_channel_url")
    .eq("id", tournamentId)
    .maybeSingle();
  if (tError) return NextResponse.json({ error: tError.message }, { status: 500 });
  if (!tournament) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  if (!tournament.youtube_channel_url) {
    return NextResponse.json({ ok: true, updated: 0, message: "No YouTube channel set on this tournament — nothing to do." });
  }

  const channelId = await resolveChannelId(tournament.youtube_channel_url, apiKey);
  if (!channelId) {
    return NextResponse.json(
      { ok: true, updated: 0, message: `Couldn't resolve a channel ID for "${tournament.youtube_channel_url}" — check the URL.` }
    );
  }

  const [liveIds, upcomingIds] = await Promise.all([
    searchVideoIds(channelId, "live", apiKey),
    searchVideoIds(channelId, "upcoming", apiKey),
  ]);
  const videoIds = [...new Set([...liveIds, ...upcomingIds])];
  const details = await fetchLiveStreamingDetails(videoIds, apiKey);

  // One found stream per calendar date (UTC) — first one wins if the
  // channel happens to have more than one live/upcoming stream on the
  // same day, matching the "best-effort" spirit of the existing YouTube
  // fallback code rather than trying to disambiguate further.
  const urlByDate = new Map<string, string>();
  for (const item of details) {
    const startTime = item.liveStreamingDetails?.scheduledStartTime ?? item.liveStreamingDetails?.actualStartTime;
    if (!startTime || !item.id) continue;
    const dateKey = utcDateKey(startTime);
    if (!urlByDate.has(dateKey)) urlByDate.set(dateKey, `https://www.youtube.com/watch?v=${item.id}`);
  }

  if (urlByDate.size === 0) {
    return NextResponse.json({ ok: true, updated: 0, message: "No public live/upcoming streams found on this channel right now." });
  }

  // Only fill matches that don't already have a link — never clobber one
  // that was already set (manually, or by an earlier sync/Liquipedia
  // import), and only future/in-progress matches (a finished match's VOD
  // link should come from finishedMatchSync, not a live/upcoming search).
  const { data: matches, error: mError } = await supabase
    .from("matches")
    .select("id, scheduled_at, youtube_url")
    .eq("tournament_id", tournamentId)
    .is("youtube_url", null)
    .neq("status", "finished");
  if (mError) return NextResponse.json({ error: mError.message }, { status: 500 });

  let updated = 0;
  for (const match of matches ?? []) {
    if (!match.scheduled_at) continue;
    const url = urlByDate.get(utcDateKey(match.scheduled_at));
    if (!url) continue;
    const { error: updateError } = await supabase.from("matches").update({ youtube_url: url }).eq("id", match.id);
    if (!updateError) updated += 1;
  }

  return NextResponse.json({
    ok: true,
    updated,
    message: updated > 0
      ? `Matched ${updated} match${updated === 1 ? "" : "es"} to a stream by date.`
      : "Found live/upcoming streams, but no unlinked match shared their date.",
  });
}
