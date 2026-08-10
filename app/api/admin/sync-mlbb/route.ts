import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { syncMLBBDataToDatabase } from "@/services/mlbb-liquipedia-sync";
import { recordQueryTime, recordError } from "@/lib/metrics";
import { clearQueryCache } from "@/lib/queryCache";

export const maxDuration = 600; // 10 minutes for sync operations

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: authHeader } },
      }
    );

    // Verify admin access
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: isAdmin } = await supabase.rpc("is_admin");
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    console.log("[MLBB Sync API] Starting sync triggered by admin...");

    // Run the sync
    const syncResult = await syncMLBBDataToDatabase();

    // Clear related caches to force fresh data
    clearQueryCache("tournaments");
    clearQueryCache("matches");
    clearQueryCache("teams");
    clearQueryCache("players");

    const duration = Date.now() - startTime;
    recordQueryTime("mlbb_sync", duration);

    console.log(`[MLBB Sync API] Sync completed in ${duration}ms`);

    return NextResponse.json(
      {
        success: true,
        data: syncResult,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
        cacheCleared: ["tournaments", "matches", "teams", "players"],
      },
      { status: 200 }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[MLBB Sync API] Error after ${duration}ms:`, error);
    recordError("mlbb_sync_failed");

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

// GET endpoint to check sync status (for monitoring)
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: authHeader } },
      }
    );

    // Verify admin access
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: isAdmin } = await supabase.rpc("is_admin");
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Get current MLBB data stats
    const { data: tournaments, error: tourError } = await supabase
      .from("tournaments")
      .select("id, name, tier")
      .in("tier", ["S", "A"])
      .limit(1000);

    const { data: matches, error: matchError } = await supabase
      .from("matches")
      .select("id, tournament_id")
      .limit(1000);

    const { data: teams, error: teamError } = await supabase.from("teams").select("id").limit(1000);

    const { data: players, error: playerError } = await supabase
      .from("players")
      .select("id")
      .limit(1000);

    return NextResponse.json(
      {
        status: "ok",
        data: {
          tournaments: tournaments?.length || 0,
          matches: matches?.length || 0,
          teams: teams?.length || 0,
          players: players?.length || 0,
        },
        message: "Use POST request to trigger sync",
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[MLBB Sync API] GET error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
