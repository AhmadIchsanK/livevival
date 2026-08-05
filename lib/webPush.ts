// Client-side Web Push subscribe flow for the "follow" bell. Deliberately
// does NOT read VAPID_PUBLIC_KEY from a NEXT_PUBLIC_-prefixed env var —
// fetching it from /api/push/vapid-public-key instead means the exact same
// env var name the worker's send path uses (VAPID_PUBLIC_KEY, no prefix)
// works for both, and this file no-ops cleanly with a clear reason when
// it isn't set yet rather than needing a second build-time-baked copy of
// the same key kept in sync across two places.

// PushManager.subscribe wants the VAPID public key as a raw Uint8Array
// (the "applicationServerKey"), not the base64url string the server hands
// out — this is the standard conversion recipe for that.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export type FollowEntityType = "match" | "tournament";

export type FollowResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "not-configured" | "error"; message: string };

// True on every desktop browser and on Android Chrome/Firefox. False on
// iOS/iPadOS Safari UNLESS the site has been added to the home screen as a
// PWA first — Apple's own restriction on Web Push since iOS 16.4, with no
// workaround (this site already ships a web app manifest + icons, see
// public/site.webmanifest, so "Add to Home Screen" is available; there's
// no way to trigger that add-to-home-screen prompt programmatically,
// Safari requires the user to do it via the Share sheet).
export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIosNonStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // iOS Safari's non-standard `navigator.standalone` is true once launched
  // from a home-screen icon — that's the only signal available for "was
  // this added to the home screen", there's no official API for it.
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return isIos && !standalone;
}

export async function subscribeToFollow(entityType: FollowEntityType, entityId: string): Promise<FollowResult> {
  if (!isPushSupported()) {
    return { ok: false, reason: "unsupported", message: "This browser doesn't support push notifications." };
  }

  const keyRes = await fetch("/api/push/vapid-public-key").catch(() => null);
  if (!keyRes || !keyRes.ok) {
    return {
      ok: false,
      reason: "not-configured",
      message: "Push notifications aren't set up on this deployment yet.",
    };
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "denied", message: "Notification permission was not granted." };
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    // Push subscriptions only need a worker that's installed, not
    // necessarily the one already controlling this page (e.g. first visit).
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, // required by the spec — every push must surface a visible notification
        // TS's lib.dom BufferSource typing wants an ArrayBuffer-backed
        // view specifically (not the wider ArrayBufferLike our Uint8Array
        // is typed with) — the runtime value is exactly what the spec
        // wants, this cast just satisfies the stricter compile-time type.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }

    const subJson = subscription.toJSON();
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
        entityType,
        entityId,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Unknown error" }));
      return { ok: false, reason: "error", message: body.error || "Failed to save subscription." };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : "Failed to subscribe." };
  }
}
