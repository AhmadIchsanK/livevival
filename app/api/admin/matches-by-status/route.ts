import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { withQueryCache } from "@/lib/queryCache";
import { recordQueryTime } from "@/lib/metrics";

const MATCHES_PAGE_SIZE = 20;

type CachedMatch = {
  id: string;
  scheduled_at: string | null;
  format: string | null;
  stage: string | null;
  status: string;
  youtube_url: string | null;
  state: string;
  stream_id: string | null;
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
  tournament_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  tournament: { name: string; liquipedia_slug: string | null } | null;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const searchParams = req.nextUrl.searchParams;
  const status = searchParams.get("status") || "live";
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  // Normal / Priority / Hot filter — mirrors lib/matchTier.ts's
  // displayMatchTier() derivation (local_ocr always reads as Hot regardless
  // of its stored notification_tier) so the filter matches what the tier
  // dropdown actually shows in the UI.
  const tier = searchParams.get("tier");

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    // Use aggressive query caching for status-filtered matches. Paginated
    // for every status now — an unpaginated Upcoming list was the slow path
    // this endpoint existed to fix in the first place, since a growing
    // schedule just kept shipping every row down. "live" is included too:
    // it's usually just a handful, but a big multi-stage day can push many
    // matches live at once, and this endpoint shouldn't have a status that
    // silently stops scaling.
    const paginated = true;
    const cacheKey = `admin:matches:${status}:${tier ?? "all"}:${offset}`;

    const data = await withQueryCache(
      { strategy: "short", key: cacheKey },
      async () => {
        let query = supabase
          .from("matches")
          .select(
            `id, scheduled_at, format, stage, status, youtube_url, state, stream_id, update_source, notification_tier,
             tournament_id, team_a_id, team_b_id,
             tournament:tournaments(name, liquipedia_slug),
             team_a:teams!matches_team_a_id_fkey(name),
             team_b:teams!matches_team_b_id_fkey(name)`
          )
          .eq("status", status);

        if (tier === "hot") {
          query = query.or("update_source.eq.local_ocr,notification_tier.eq.hot");
        } else if (tier === "normal" || tier === "priority") {
          query = query.eq("notification_tier", tier).neq("update_source", "local_ocr");
        }

        if (status === "finished") {
          query = query.order("scheduled_at", { ascending: false });
        } else {
          query = query.order("scheduled_at", { ascending: true });
        }
        if (paginated) {
          query = query.range(offset, offset + MATCHES_PAGE_SIZE - 1);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data;
      }
    );

    const duration = Date.now() - startTime;
    recordQueryTime("admin_matches_fetch", duration);

    const hasMore = paginated && (data?.length ?? 0) === MATCHES_PAGE_SIZE;

    return NextResponse.json(
      {
        matches: data as unknown as CachedMatch[] | null,
        hasMore,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "private, max-age=120", // 2 min browser cache
        },
      }
    );
  } catch (error) {
    console.error("[Admin Matches API] Error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
