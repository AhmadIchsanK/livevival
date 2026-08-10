import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { metrics } from "@/lib/metrics";
import { getQueryCacheStats } from "@/lib/queryCache";

export async function GET(req: NextRequest) {
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

  // Get all available metrics
  const allMetrics = metrics.getAllMetrics();
  const health = metrics.getHealthStatus();
  const queryCacheStats = getQueryCacheStats();

  const cacheHitRate = metrics.getHitRate("cache:hit", "cache:miss");
  const queryAvgTime = metrics.getAverage("query_time_ms");
  const responseP95 = metrics.getPercentile("response_time_ms", 95);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    health,
    summary: {
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      queryAverageTimeMs: Math.round(queryAvgTime),
      responseP95Ms: Math.round(responseP95),
      queryCacheStats,
      totalRequests: metrics.getCounter("requests:total"),
      totalErrors: metrics.getCounter("errors:total"),
      cronRefreshes: metrics.getCounter("cron:refresh:success"),
    },
    metrics: allMetrics,
  });
}
