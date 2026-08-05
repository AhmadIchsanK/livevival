// Web Push service worker — this is the whole reason "follow" notifications
// keep arriving with the tab closed: once registered, the browser keeps
// this worker alive in the background (subject to the OS/browser's own
// battery-saving rules) and wakes it specifically to handle an incoming
// push, with no page open at all. Registered from lib/webPush.ts.
//
// Scope is "/" (the default for a worker served from the site root), so it
// can intercept pushes regardless of which page the user followed from.
// This file intentionally does NOT implement a fetch handler / cache — it
// exists only to receive push events, not to make the site work offline.

self.addEventListener("install", () => {
  // Activate immediately instead of waiting for all existing tabs of the
  // old worker (if any) to close — there's no cached content here whose
  // versioning that staging would protect, and a follow that just happened
  // should be receivable as soon as possible.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Livevival", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Livevival";
  const url = payload.url || "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: payload.icon || "/app-icons/app-icon-192.png",
      badge: payload.badge || "/app-icons/app-icon-192.png",
      tag: payload.tag || url, // a second push for the same match replaces the first instead of stacking
      renotify: true,
      data: { url },
    })
  );
});

// Clicking the notification focuses an already-open tab on that match/
// tournament page if one exists, otherwise opens a new one — matches the
// behavior fans expect from every other native-app push.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.pathname === url && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
