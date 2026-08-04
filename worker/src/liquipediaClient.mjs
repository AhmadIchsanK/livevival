// Shared Liquipedia api.php client for the always-on worker. Respects
// Liquipedia's API Terms of Use: custom User-Agent + contact email, only
// ever calls api.php (never scrapes a rendered page directly), and a
// single process-wide gate ensures at least 2 seconds between ANY two
// requests this process makes, regardless of how many tournaments are
// being polled in one tick.

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";
// Production logs from the GitHub Actions importers show Liquipedia enforces
// a broader short-term throttle after a burst of requests, not just the
// documented "1 request / 2s" — 4s here plus a longer/harder retry backoff
// below gives this always-on process more headroom to avoid tripping it.
const MIN_GAP_MS = 4000;

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gate() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export async function fetchRenderedPage(pageTitle, attempt = 1) {
  await gate();

  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  // Without this, a page that's actually a redirect (e.g. a tournament
  // slug Liquipedia has since renamed) returns the redirect stub's
  // near-empty content instead of the real page — silently, no error.
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });

  // Production logs show every one of the previous 4 escalating retries
  // (20/40/60/80s, ~200s total) failing every single time once actually
  // rate-limited — that in-tick retry chain wasn't recovering anything, it
  // was just delaying how soon index.mjs's much-more-effective per-
  // tournament cooldown kicked in. Failing fast after 2 short retries and
  // letting that cooldown do the real backoff work stops hammering
  // Liquipedia while still tolerating one genuinely transient 429.
  if (res.status === 429 && attempt <= 2) {
    const waitMs = 20000 * attempt;
    console.warn(`Rate limited on ${pageTitle}, waiting ${waitMs / 1000}s before retry ${attempt}/2...`);
    await sleep(waitMs);
    return fetchRenderedPage(pageTitle, attempt + 1);
  }
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);

  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}
