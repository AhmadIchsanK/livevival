import { NextResponse, NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { clearQueryCache } from "@/lib/queryCache";

// Match lifecycle cron — the piece that was missing entirely. Nothing was ever
// moving a match off "scheduled", so once its start time passed it fell out of
// the upcoming window (scheduled_at < now) while still being status=scheduled,
// so it vanished: not upcoming, not live, not finished.
//
// This runs frequently (DB-only, no Liquipedia — cheap, no rate-limit concern)
// and does exactly one thing: flip a match to LIVE when its scheduled time has
// arrived, regardless of whether it has a stream URL yet (per the product call
// — a match should go live on schedule; the stream link is found separately).
// Marking a live match FINISHED is deliberately NOT done here: that needs a
// real result (score/winner), which comes from the Hot-match flow or the
// Liquipedia result sync — auto-finishing on a timer would create scoreless
// history rows. A generous safety cap only surfaces matches that have been
// "live" implausibly long (a scrape/data problem) without mutating them.

export const maxDuration = 60;

// How far past scheduled_at a match may sit before we assume its data is stale
// rather than genuinely live — reported, never auto-mutated.
const STALE_LIVE_HOURS = 12;
// Only promote matches whose start time is recent. A match still "scheduled"
// from long ago is stale data (it should have been played/finished), not
// something to surface as live — promoting the whole backlog would flood the
// live section.
const PROMOTE_LOOKBACK_HOURS = 12;

function serviceClient() {
  // Prefer the service-role key so the cron can update rows under RLS; fall
  // back to the anon key (works if a permissive policy exists) so a missing
  // env var degrades to "read + attempt" instead of a hard crash.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

async function runLifecycle() {
  const supabase = serviceClient();
  const nowIso = new Date().toISOString();

  // scheduled → live: start time has arrived (within the recent lookback). No
  // stream-URL requirement — a match goes live on schedule; the stream link is
  // found separately.
  const lookbackIso = new Date(Date.now() - PROMOTE_LOOKBACK_HOURS * 3600_000).toISOString();
  const { data: toLive, error: selErr } = await supabase
    .from("matches")
    .select("id, scheduled_at, status")
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .gte("scheduled_at", lookbackIso)
    .limit(500);
  if (selErr) throw selErr;

  let promoted = 0;
  const ids = (toLive ?? []).map((m: { id: string }) => m.id);
  if (ids.length > 0) {
    const { error: updErr } = await supabase.from("matches").update({ status: "live" }).in("id", ids);
    if (updErr) throw updErr;
    promoted = ids.length;
    clearQueryCache("matches");
  }

  // Diagnostic only: matches that have been "live" implausibly long (likely a
  // never-finished scrape), so a human/other job can reconcile them. Never
  // mutated here — finishing requires a real result.
  const staleCutoff = new Date(Date.now() - STALE_LIVE_HOURS * 3600_000).toISOString();
  const { data: stale } = await supabase
    .from("matches")
    .select("id")
    .eq("status", "live")
    .lte("scheduled_at", staleCutoff)
    .limit(200);

  return { promoted, promotedIds: ids, staleLive: (stale ?? []).length };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runLifecycle();
    return NextResponse.json(
      { success: true, ...result, timestamp: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// Admin-triggerable on demand (same auth shape as refresh-schedule's POST).
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return GET(req);
}
