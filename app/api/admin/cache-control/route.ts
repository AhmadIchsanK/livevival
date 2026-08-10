import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { clearCache, getRedisMetrics } from "@/lib/redis";

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

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "clear-all";

    if (action === "clear-all") {
      await clearCache("schedule:all");
      return NextResponse.json({
        success: true,
        action: "clear-all",
        message: "All cache cleared",
        timestamp: new Date().toISOString(),
      });
    }

    if (action === "clear-schedule") {
      await clearCache("schedule:all");
      return NextResponse.json({
        success: true,
        action: "clear-schedule",
        message: "Schedule cache cleared",
        timestamp: new Date().toISOString(),
      });
    }

    if (action === "status") {
      try {
        const metrics = await getRedisMetrics();
        return NextResponse.json({
          success: true,
          action: "status",
          redis: metrics,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return NextResponse.json(
          {
            success: false,
            action: "status",
            error: error instanceof Error ? error.message : "Unknown error",
            timestamp: new Date().toISOString(),
          },
          { status: 503 }
        );
      }
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
