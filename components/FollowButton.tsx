"use client";

import { useEffect, useState } from "react";
import { subscribeToFollow, isIosNonStandalone, type FollowEntityType } from "@/lib/webPush";

// "Follow" bell for native Web Push on a match/tournament — the whole
// point is that it keeps notifying with the tab closed, as long as the
// browser is running (even just in the background), on any browser: no
// third-party push service, just the standard Push API + a service worker
// (public/sw.js) + VAPID keys the worker signs with server-side.
//
// push_subscriptions has no public SELECT policy (see the migration), so
// there's no way to ask the server "is this browser already following
// this?" — localStorage is this button's only source of "already
// followed" state, scoped per entity so it's independent per match/
// tournament. That's a real limitation (a second device, or clearing site
// data, forgets it), but it's the correct tradeoff for a table that's
// otherwise write-only from the client.
export function FollowButton({
  entityType,
  entityId,
  className = "",
}: {
  entityType: FollowEntityType;
  entityId: string;
  className?: string;
}) {
  const storageKey = `lv-followed-${entityType}-${entityId}`;
  const [followed, setFollowed] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "message">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setFollowed(typeof window !== "undefined" && localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  async function handleClick() {
    if (followed || status === "loading") return;

    // iOS/iPadOS Safari can't do Web Push at all unless the site was
    // opened as a home-screen PWA first (Apple's own platform restriction,
    // no workaround) — worth telling the fan why the permission prompt
    // never showed, rather than silently failing.
    if (isIosNonStandalone()) {
      setStatus("message");
      setMessage("On iPhone/iPad, add this site to your Home Screen first (Share → Add to Home Screen), then tap Follow again.");
      return;
    }

    setStatus("loading");
    const result = await subscribeToFollow(entityType, entityId);
    if (result.ok) {
      localStorage.setItem(storageKey, "1");
      setFollowed(true);
      setStatus("idle");
      setMessage(null);
    } else {
      setStatus("message");
      setMessage(result.message);
    }
  }

  return (
    <div className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "loading"}
        title={followed ? "You'll get a push notification for this — even with the tab closed" : "Get notified — even with this tab closed"}
        aria-pressed={followed}
        className={`lv-badge flex items-center gap-1.5 transition-colors duration-200 ${
          followed
            ? "bg-signal/20 text-signal border border-signal/40"
            : "bg-white/10 text-white/70 border border-white/10 hover:border-signal/40 hover:text-signal"
        } ${status === "loading" ? "opacity-60 cursor-wait" : ""}`}
        onBlur={() => status === "message" && setStatus("idle")}
      >
        {followed ? "🔔 Following" : "🔕 Follow"}
      </button>
      {status === "message" && message && (
        <div
          role="status"
          className="absolute top-full left-0 mt-2 z-20 w-64 text-xs text-white/80 bg-ink border border-white/15 rounded-md p-2.5 shadow-lg"
        >
          {message}
          <button type="button" onClick={() => setStatus("idle")} className="block mt-1.5 text-white/40 hover:text-white/70 underline">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
