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
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });

  if (res.status === 429 && attempt <= 4) {
    const waitMs = 20000 * attempt;
    console.warn(`Rate limited on ${pageTitle}, waiting ${waitMs / 1000}s before retry ${attempt}/4...`);
    await sleep(waitMs);
    return fetchRenderedPage(pageTitle, attempt + 1);
  }
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);

  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}
