import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { setSchedule, CachedScheduleData } from "@/lib/redis";
import { scrapeAllUpcomingMatches } from "@/services/liquipedia-scraper";
import { withQueryCache, clearQueryCache } from "@/lib/queryCache";
import {
  metrics,
  recordQueryTime,
  recordError,
  recordCacheHit,
  recordCacheMiss,
} from "@/lib/metrics";

export const maxDuration = 300; // 5 minutes max for this endpoint

async function getScheduleFromDatabase(): Promise<CachedScheduleData | null> {
  const queryStartTime = Date.now();

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    // Use query cache for tournaments (long TTL)
    const tournaments = await withQueryCache(
      { strategy: "long", key: "tournaments:all" },
      async () => {
        const { data } = await supabase.from("tournaments").select("id, name, tier");
        return data;
      }
    );

    // Use query cache for matches (medium TTL since they change more frequently)
    const matches = await withQueryCache(
      { strategy: "medium", key: "matches:all:with_relations" },
      async () => {
        const { data } = await supabase
          .from("matches")
          .select(
            `id, status, scheduled_at, format,
            tournament:tournaments(id, name, tier),
            team_a:teams!matches_team_a_id_fkey(id, name),
            team_b:teams!matches_team_b_id_fkey(id, name),
            stream:streams!matches_stream_id_fkey(url)`
          )
          .order("scheduled_at", { ascending: true })
          .limit(500);
        return data;
      }
    );

    const queryDuration = Date.now() - queryStartTime;
    recordQueryTime("schedule_fetch", queryDuration);

    if (!tournaments || !matches) {
      recordError("schedule_fetch_incomplete");
      return null;
    }

    return {
      tournaments: tournaments.map((t: any) => ({
        id: t.id,
        name: t.name,
        tier: t.tier,
      })),
      matches: (matches as any[]).map((m) => ({
        id: m.id,
        status: m.status,
        scheduledAt: m.scheduled_at,
        format: m.format,
        tournament: m.tournament,
        teamA: m.team_a,
        teamB: m.team_b,
        streamUrl: m.stream?.url ?? null,
      })),
      lastRefreshed: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[Cron] Error fetching from database:", error);
    recordError("database_fetch");
    return null;
  }
}

export async function GET(req: NextRequest) {
  // Verify authorization for cron
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  console.log("[Cron] Starting schedule refresh...");

  try {
    // Try to get fresh data from database (uses query cache internally)
    console.log("[Cron] Fetching schedule from database...");
    const scheduleData = await getScheduleFromDatabase();

    if (!scheduleData) {
      console.error("[Cron] Failed to fetch schedule from database");
      recordError("schedule_fetch_failed");
      return NextResponse.json(
        { error: "Failed to fetch schedule", timestamp: new Date().toISOString() },
        { status: 500 }
      );
    }

    // Cache in Redis with 35-minute TTL (cron runs every 30 minutes)
    const cacheKey = "schedule:all";
    await setSchedule(cacheKey, scheduleData, 2100); // 35 minutes

    // Clear related query caches to force fresh data on next request
    clearQueryCache("matches");
    clearQueryCache("tournaments");

    recordCacheHit("redis_schedule");

    const duration = Date.now() - startTime;
    console.log(`[Cron] Schedule refresh completed in ${duration}ms`);
    console.log(
      `[Cron] Cached ${scheduleData.tournaments.length} tournaments and ${scheduleData.matches.length} matches`
    );

    // Record metrics
    metrics.increment("cron:refresh:success");
    metrics.record("cron:refresh:duration_ms", duration);

    return NextResponse.json(
      {
        success: true,
        cached: {
          tournaments: scheduleData.tournaments.length,
          matches: scheduleData.matches.length,
        },
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
        metrics: metrics.getHealthStatus(),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Cron] Error after ${duration}ms:`, error);
    recordError("cron_refresh");
    metrics.increment("cron:refresh:error");

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

// POST handler for manual triggers
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  return GET(req);
}
