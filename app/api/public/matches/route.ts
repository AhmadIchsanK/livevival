import { NextResponse } from "next/server";
import { clampLimit, getPublicMatches, parseStatus, DEFAULT_LIMIT, MAX_LIMIT } from "@/lib/publicMatches";

// Public, unauthenticated, read-only JSON feed of match data — everything
// here is already visible on the site itself (the home page and match
// pages), just reshaped for external consumers. No admin/contributor auth,
// no rate-limiting or API-key layer by design: this is deliberately the
// simplest possible read surface, matching the same public data the site
// already serves. Cached at the edge for 30s so a burst of external
// requests doesn't turn into a burst of Supabase queries.
//
// GET /api/public/matches
// GET /api/public/matches?status=live|scheduled|finished
// GET /api/public/matches?limit=20   (default 50, hard-capped at 200)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = parseStatus(searchParams.get("status"));
  const limit = clampLimit(searchParams.get("limit"));
  const base = new URL(req.url).origin;

  try {
    const matches = await getPublicMatches({ status, limit });

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: status ?? "all",
        limit,
        maxLimit: MAX_LIMIT,
        defaultLimit: DEFAULT_LIMIT,
        count: matches.length,
        matches: matches.map((m) => ({
          id: m.id,
          status: m.status,
          scheduledAt: m.scheduledAt,
          format: m.format,
          tournament: m.tournament,
          teamA: m.teamA,
          teamB: m.teamB,
          score: m.score,
          streamUrl: m.streamUrl,
          url: `${base}${m.path}`,
        })),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
