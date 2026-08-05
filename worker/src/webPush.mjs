// Native browser Web Push send path — the worker-side half of the
// "follow" bell (app/api/push/subscribe/route.ts on the Next.js side).
// Zero third-party push service: just the standard Push API, VAPID keys
// generated once by the owner (see the PR description this shipped in),
// and the `web-push` npm library doing the signing/encryption per the
// RFC 8291/8292 Web Push spec.
//
// No-ops (with a one-time console note) when VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, or VAPID_SUBJECT aren't set, same pattern as
// telegram.mjs's TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID guard — safe to call
// unconditionally from anywhere in the worker without breaking
// deployments that haven't set these yet.

import webpush from "web-push";
import { supabase } from "./config.mjs";

let vapidConfigured = false;
let warnedMissingConfig = false;

function ensureConfigured() {
  if (vapidConfigured) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    if (!warnedMissingConfig) {
      console.log(
        "Web Push not configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT unset) — skipping push notifications."
      );
      warnedMissingConfig = true;
    }
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

// The Telegram/Slack text this worker already builds (see telegram.mjs
// call sites) is lightly HTML-formatted (<b>…</b>) and often multi-line
// with a recap dump after the headline — fine for a chat message, too
// much for a native notification. This takes the first line as the title
// and folds the rest into a short body.
function toNotificationPayload(text) {
  const plain = text.replace(/<\/?b>/g, "").trim();
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  const title = lines[0] || "Livevival";
  const body = lines.slice(1).join(" · ").slice(0, 300);
  return { title, body };
}

// Sends a push to every subscriber of one match/tournament. Silently no-ops
// if there are no subscribers or VAPID isn't configured — this is meant to
// be called unconditionally alongside notifyOnce's Telegram send, not
// gated by anything the caller has to check first.
export async function sendPushNotifications(entityType, entityId, text) {
  if (!ensureConfigured()) return;

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);

  if (error) {
    console.error("Failed to load push subscriptions:", error.message);
    return;
  }
  if (!subs || subs.length === 0) return;

  const { title, body } = toNotificationPayload(text);
  const payload = JSON.stringify({
    title,
    body,
    url: entityType === "match" ? `/match/${entityId}` : "/tournaments",
    tag: `${entityType}-${entityId}`,
  });

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (err) {
        // 404/410 is the push service (FCM, Mozilla's push service, etc.)
        // telling us this endpoint is permanently gone — the browser
        // unsubscribed, the user cleared site data, whatever. Standard Web
        // Push hygiene is to delete it rather than retry it forever.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error(`Push send failed (${err?.statusCode ?? "?"}) for subscription ${sub.id}:`, err?.message ?? err);
        }
      }
    })
  );
}
