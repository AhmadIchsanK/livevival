import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Slack Events API endpoint — set as the Request URL for Event
// Subscriptions (subscribed to the "message.im" bot event) once
// SLACK_SIGNING_SECRET/SLACK_BOT_TOKEN are configured. Handles the two
// things a person can DM the bot to control their own Slack DM copies of
// every channel notification: "on"/"subscribe" and "off"/"unsubscribe".
function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null, signingSecret: string): boolean {
  if (!timestamp || !signature) return false;
  // Slack rejects requests older than 5 minutes to prevent replay — mirror
  // that here rather than trusting an arbitrarily old signed payload.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function POST(req: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!signingSecret || !botToken) {
    return NextResponse.json({ error: "Slack isn't configured yet." }, { status: 503 });
  }

  const rawBody = await req.text();
  const valid = verifySlackSignature(
    rawBody,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    signingSecret
  );
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const payload = JSON.parse(rawBody);

  // One-time handshake when the Request URL is first saved in Slack's
  // Event Subscriptions settings.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
  if (
    payload.type === "event_callback" &&
    event?.type === "message" &&
    event.channel_type === "im" &&
    !event.bot_id &&
    typeof event.text === "string" &&
    event.user
  ) {
    const text = event.text.trim().toLowerCase();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceRoleKey) {
      const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey);
      let reply: string | null = null;
      if (["on", "subscribe", "enable"].includes(text)) {
        await svc.from("slack_dm_subscriptions").upsert(
          { slack_user_id: event.user, enabled: true, updated_at: new Date().toISOString() },
          { onConflict: "slack_user_id" }
        );
        reply = "✅ You'll now get a DM copy of every LiveVival notification. Send \"off\" any time to stop.";
      } else if (["off", "unsubscribe", "disable"].includes(text)) {
        await svc.from("slack_dm_subscriptions").upsert(
          { slack_user_id: event.user, enabled: false, updated_at: new Date().toISOString() },
          { onConflict: "slack_user_id" }
        );
        reply = "🔕 DM copies turned off. Send \"on\" any time to turn them back on.";
      } else {
        reply = 'Send "on" to get a DM copy of every notification, or "off" to stop.';
      }
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: event.channel, text: reply }),
      }).catch(() => {});
    }
  }

  // Slack requires a fast 200 regardless of what the event handling above
  // did — it retries on anything else, which would double-process a DM.
  return NextResponse.json({ ok: true });
}
