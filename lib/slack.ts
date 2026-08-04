import { createClient } from "@supabase/supabase-js";

// Slack mirror of the Telegram bot — every Telegram notification also goes
// to a Slack channel (and to any DM-opted-in user) via this module. Not yet
// provisioned as of this writing: SLACK_BOT_TOKEN / SLACK_CHANNEL_ID need
// setting in this deployment's environment variables before any of this
// actually sends anything. Every function here is best-effort and never
// throws — a missing/broken Slack config should never block the Telegram
// send it mirrors.

// Telegram messages are built with HTML parse_mode (<b>...</b> for bold,
// literal \n for line breaks). Slack's mrkdwn uses *...* for bold and the
// same \n — this is the only conversion actually needed given what this
// codebase's message builders use.
function telegramHtmlToSlackMrkdwn(text: string): string {
  return text.replace(/<b>/g, "*").replace(/<\/b>/g, "*");
}

// SLACK_CHANNEL_ID accepts a comma-separated list — every notification
// posts to all of them. The bot must be invited to each one
// (/invite @<bot> in Slack) or chat:write.public is required.
function slackConfigured(): { token: string; channels: string[] } | null {
  const token = process.env.SLACK_BOT_TOKEN;
  const channels = (process.env.SLACK_CHANNEL_ID ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (!token || channels.length === 0) return null;
  return { token, channels };
}

async function slackApi(method: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: "invalid_response" }));
  return json as { ok: boolean; error?: string; channel?: string };
}

function messageBlocks(message: string, photoUrl?: string) {
  const text = telegramHtmlToSlackMrkdwn(message);
  const blocks: Record<string, unknown>[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (photoUrl) blocks.push({ type: "image", image_url: photoUrl, alt_text: "screenshot" });
  return { text, blocks };
}

// Posts to every configured channel — the direct equivalent of
// postToTelegram's sendMessage/sendPhoto. Silently no-ops if unconfigured.
export async function postToSlackChannel(message: string, photoUrl?: string): Promise<void> {
  const config = slackConfigured();
  if (!config) return;
  const { text, blocks } = messageBlocks(message, photoUrl);
  for (const channel of config.channels) {
    await slackApi("chat.postMessage", config.token, { channel, text, blocks }).catch(() => {});
  }
}

async function sendSlackDM(token: string, userId: string, message: string, photoUrl?: string) {
  const opened = await slackApi("conversations.open", token, { users: userId }).catch(() => null);
  const dmChannel = opened?.channel;
  if (!dmChannel) return;
  const { text, blocks } = messageBlocks(message, photoUrl);
  await slackApi("chat.postMessage", token, { channel: dmChannel, text, blocks }).catch(() => {});
}

// Every DM-subscribed user (see slack_dm_subscriptions, toggled via the
// /api/slack/events "on"/"off" DM commands) gets their own copy alongside
// the channel post.
async function dmAllSubscribers(token: string, message: string, photoUrl?: string) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return; // no way to read subscriber list without it — channel post above still goes out
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey);
  const { data: subs } = await svc.from("slack_dm_subscriptions").select("slack_user_id").eq("enabled", true);
  for (const sub of (subs as { slack_user_id: string }[] | null) ?? []) {
    await sendSlackDM(token, sub.slack_user_id, message, photoUrl);
  }
}

// The single entry point every Telegram send-site calls alongside
// postToTelegram — posts to the channel, then DMs whoever's opted in.
export async function broadcastToSlack(message: string, photoUrl?: string): Promise<void> {
  const config = slackConfigured();
  if (!config) return;
  await postToSlackChannel(message, photoUrl);
  await dmAllSubscribers(config.token, message, photoUrl).catch(() => {});
}
