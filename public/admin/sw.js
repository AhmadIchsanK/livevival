// Admin static-asset cache — a SEPARATE worker from the site-root /sw.js
// (Web Push only, scope "/", see that file's own header comment). This
// one is served from /admin/sw.js, which makes "/admin/" its default
// scope with no extra server header needed, so it only ever controls
// pages under /admin. Registered from app/admin/AdminShell.tsx.
//
// Deliberately an ALLOWLIST, not a denylist: only same-origin
// /_next/static/* build output plus the /app-icons/ and /favicons/ image
// paths are ever touched. Every other request — every Supabase call,
// every /api/* route, every page navigation/RSC data fetch — falls
// straight through to the network untouched, because this worker never
// calls event.respondWith() for it. A live match's score, OCR tracker
// readings, and draft state must never be served stale, so this worker
// doesn't get a vote on those requests at all — not even a "network-first,
// fall back to cache" vote. Caching those, even conservatively, is exactly
// the kind of "looks like a PWA" regression that would make an admin
// stare at a stale kill count during a live match.

const CACHE_NAME = "livevival-admin-static-v1";

const CACHEABLE_PREFIXES = ["/_next/static/", "/app-icons/", "/favicons/"];

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  return CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("livevival-admin-static-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return; // never intervene on a write
  const url = new URL(event.request.url);
  if (!isCacheable(url)) return; // everything else — Supabase, /api/*, page loads — untouched

  // Next.js build output under /_next/static/ is content-hashed: the same
  // URL never changes what it serves, so cache-first with no revalidation
  // is both safe and the fastest option.
  const isHashedBuildAsset = url.pathname.startsWith("/_next/static/");

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (isHashedBuildAsset && cached) return cached;

      const revalidate = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null);

      // Icons/favicons aren't hashed — stale-while-revalidate: serve the
      // cached copy instantly if there is one, refresh it in the
      // background either way (kept alive via waitUntil so the worker
      // isn't torn down mid-fetch once this response is already sent).
      if (cached) {
        event.waitUntil(revalidate);
        return cached;
      }
      return (await revalidate) ?? fetch(event.request);
    })()
  );
});
