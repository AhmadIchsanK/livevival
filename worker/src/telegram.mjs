// Outbound-only Telegram notifications — no bot commands, no webhook, just
// fire-and-forget POSTs to Telegram's Bot API's sendMessage endpoint.
// No-ops (with a one-time console note) when TELEGRAM_BOT_TOKEN or
// TELEGRAM_CHAT_ID aren't set, so this is safe to call unconditionally
// from anywhere in the worker without breaking deployments that haven't
// configured a bot yet.
//
// Activation (not done by this code — needs the account owner):
//   1. Message @BotFather on Telegram, /newbot, get the token.
//   2. Add the bot to the target group/channel, get its chat_id (e.g. via
//      https://api.telegram.org/bot<TOKEN>/getUpdates after posting any
//      message in the group).
//   3. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the worker's Railway
//      service and the Next.js app's Vercel project (same two vars, both
//      places send from — worker for automatic events, Next.js API route
//      for admin-triggered posts).

import { supabase } from "./config.mjs";
import { broadcastToSlack } from "./slack.mjs";

let warnedMissingConfig = false;

export async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!warnedMissingConfig) {
      console.log("Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset) — skipping notification.");
      warnedMissingConfig = true;
    }
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: false }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Telegram sendMessage failed (${res.status}): ${body}`);
      return { ok: false, error: body };
    }
    // Every automatic worker notification mirrors to Slack too — this was
    // previously only wired up on the Next.js app's admin-triggered
    // /api/telegram/notify route, which this process never calls (it POSTs
    // straight to Telegram's API), so worker-driven notifications (match
    // live, match finished, etc.) were silently never reaching Slack.
    await broadcastToSlack(text).catch((err) => console.error("Slack broadcast failed:", err.message));
    return { ok: true };
  } catch (err) {
    console.error("Telegram sendMessage request failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// Sends at most once per (entityType, entityId, notificationType) — the
// unique constraint on telegram_notifications is what actually enforces
// this under concurrent/repeated calls; the pre-check just avoids an
// unnecessary Telegram API call in the common case.
export async function notifyOnce(entityType, entityId, notificationType, text) {
  const { data: existing } = await supabase
    .from("telegram_notifications")
    .select("id")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("notification_type", notificationType)
    .maybeSingle();
  if (existing) return;

  const { error: insertError } = await supabase
    .from("telegram_notifications")
    .insert({ entity_type: entityType, entity_id: entityId, notification_type: notificationType });
  if (insertError) {
    // Unique violation means another concurrent call already claimed this
    // notification — not an error, just lost the race, so don't send.
    if (!insertError.message.includes("duplicate key")) {
      console.error(`Failed to log Telegram notification (${notificationType}):`, insertError.message);
    }
    return;
  }

  await sendTelegramMessage(text);
}
