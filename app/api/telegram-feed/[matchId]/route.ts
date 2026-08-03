import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Public, read-only feed of every Telegram notification sent for one match
// — built for the Rashid Slack integration: a per-match URL that shows
// exactly what the Telegram bot posted (not a recomputed live summary that
// could drift from the actual sent text), so Rashid can paste the same
// message Telegram got. No auth needed — this only ever exposes text that
// was already broadcast publicly to a Telegram chat.
export async function GET(req: Request, { params }: { params: { matchId: string } }) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

  const { data: match } = await supabase.from("matches").select("id").eq("id", params.matchId).single();
  if (!match) {
    return NextResponse.json({ error: "Match not found" }, { status: 404 });
  }

  const { data: notifications, error } = await supabase
    .from("telegram_notifications")
    .select("message, notification_type, sent_at")
    .eq("match_id", params.matchId)
    .not("message", "is", null)
    .order("sent_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    matchId: params.matchId,
    count: notifications?.length ?? 0,
    // Newest first — the most recent thing Telegram got is what a
    // freshly-pasted link should surface first.
    notifications: (notifications ?? []).map((n) => ({
      message: n.message,
      notificationType: n.notification_type,
      sentAt: n.sent_at,
    })),
  });
}
