import { createClient } from "@supabase/supabase-js";
import { getSchedule, CachedScheduleData } from "@/lib/redis";

// Get or fetch schedule data with Redis caching
export async function loadScheduleData(): Promise<CachedScheduleData | null> {
  const cacheKey = "schedule:all";

  // Try Redis cache first
  try {
    const cached = await getSchedule(cacheKey);
    if (cached) {
      return cached;
    }
  } catch (error) {
    console.warn("[ScheduleLoader] Redis unavailable, falling back to database");
  }

  // Fall back to database
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

    const { data: tournaments } = await supabase.from("tournaments").select("id, name, tier");

    const { data: matches } = await supabase
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

    if (!tournaments || !matches) {
      console.error("[ScheduleLoader] Failed to fetch from database");
      return null;
    }

    const data: CachedScheduleData = {
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

    console.log("[ScheduleLoader] Loaded from database");
    return data;
  } catch (error) {
    console.error("[ScheduleLoader] Error loading schedule:", error);
    return null;
  }
}

// Invalidate cache when admin creates/edits tournament or match
export async function invalidateScheduleCache(): Promise<void> {
  try {
    const { clearCache } = await import("@/lib/redis");
    await clearCache("schedule:all");
    console.log("[ScheduleLoader] Cache invalidated");
  } catch (error) {
    console.warn("[ScheduleLoader] Failed to invalidate cache:", error);
  }
}
