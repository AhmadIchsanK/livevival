import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { broadcastToSlack } from "@/lib/slack";

// Admin-triggered Telegram posts — the pieces the always-on worker can't
// automate on its own: draft recaps and key moments for matches on
// update_source='local_ocr' (Liquipedia has no live picks/bans feed for an
// in-progress series, only once the whole match is marked finished — see
// worker/src/finishedMatchSync.mjs), and anything an admin wants to
// announce manually. Verifies the caller is an authenticated admin via
// their own Supabase session token rather than a service-role key, since
// this route has no service-role credential configured in the Next.js
// deployment — RLS + is_admin() does the authorization instead.
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
  const message: string | undefined = body?.message;
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }
  // Screenshot capture (moment screenshots, game screenshots) passes its
  // uploaded Storage URL here so the image reaches Telegram the same way
  // every other auto-notification does, instead of screenshots and
  // Telegram staying two disjoint systems.
  const photoUrl: string | undefined = body?.photoUrl;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return NextResponse.json(
      { error: "Telegram isn't configured yet — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." },
      { status: 503 }
    );
  }

  const res = photoUrl
    ? await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: message, parse_mode: "HTML" }),
      })
    : await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
      });

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ error: `Telegram API error: ${errText}` }, { status: 502 });
  }

  // Best-effort mirror — every Telegram post also goes to Slack (channel +
  // any DM-opted-in user) when SLACK_BOT_TOKEN/SLACK_CHANNEL_ID are set.
  // Never blocks or fails this response on Slack's account.
  broadcastToSlack(message, photoUrl).catch(() => {});

  // entityType/entityId/notificationType are optional — only passed when
  // the caller wants this specific post logged against
  // telegram_notifications (e.g. to gray out a "posted" button); a
  // free-form manual announcement can skip them. matchId is logged
  // whenever present regardless of the other three, since it's what the
  // public per-match Telegram-feed endpoint (for the Rashid Slack
  // integration) keys off — entity_id alone isn't enough there since it's
  // polymorphic (sometimes a match id, sometimes a game/key_moment id).
  const { entityType, entityId, notificationType, matchId } = body ?? {};
  if (matchId || (entityType && entityId && notificationType)) {
    await supabase.from("telegram_notifications").insert({
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      notification_type: notificationType ?? null,
      match_id: matchId ?? null,
      message,
    });
  }

  return NextResponse.json({ ok: true });
}
