// Worker-side mirror of app/lib/slack.ts — the Next.js app's Slack
// integration only covers admin-console-triggered posts (which go through
// /api/telegram/notify). This process sends its own automatic
// notifications (match live, match finished, etc.) directly to Telegram's
// API without ever touching that route, so it needs its own copy of the
// same broadcast logic rather than inheriting it for free. Self-contained
// since worker/ is a separate npm package from the Next.js app — can't
// import lib/slack.ts across that boundary.

import { supabase } from "./config.mjs";

function telegramHtmlToSlackMrkdwn(text) {
  return text.replace(/<b>/g, "*").replace(/<\/b>/g, "*");
}

let warnedMissingConfig = false;

async function slackApi(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, error: "invalid_response" }));
}

async function sendSlackDM(token, userId, text) {
  const opened = await slackApi("conversations.open", token, { users: userId }).catch(() => null);
  const dmChannel = opened?.channel?.id;
  if (!dmChannel) return;
  await slackApi("chat.postMessage", token, { channel: dmChannel, text }).catch(() => {});
}

// Posts to the configured channel, then DMs every opted-in subscriber
// (see slack_dm_subscriptions, toggled via the Next.js app's
// /api/slack/events "on"/"off" DM commands — same table, same opt-in
// list, both processes read/write it). No-op (with a one-time console
// note) when SLACK_BOT_TOKEN/SLACK_CHANNEL_ID aren't set on this Railway
// service specifically — they're configured separately from the Vercel
// deployment's copy of the same two vars.
export async function broadcastToSlack(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    if (!warnedMissingConfig) {
      console.log("Slack not configured on this service (SLACK_BOT_TOKEN/SLACK_CHANNEL_ID unset) — skipping.");
      warnedMissingConfig = true;
    }
    return;
  }

  const mrkdwn = telegramHtmlToSlackMrkdwn(text);
  await slackApi("chat.postMessage", token, { channel, text: mrkdwn }).catch((err) =>
    console.error("Slack chat.postMessage failed:", err.message)
  );

  const { data: subs } = await supabase.from("slack_dm_subscriptions").select("slack_user_id").eq("enabled", true);
  for (const sub of subs ?? []) {
    await sendSlackDM(token, sub.slack_user_id, mrkdwn);
  }
}
