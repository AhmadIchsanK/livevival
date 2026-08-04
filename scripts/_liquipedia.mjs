// Shared Liquipedia api.php client for every import/refresh script.
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php (never scrapes a rendered page directly).
//
// Centralized after production logs showed several scripts (team-roster
// importer, tournament-results importer) had NO retry at all and died on
// the first transient 429, while others retried too few times/too briefly
// to survive what looks like a broader rate window on Liquipedia's side —
// not just the documented "1 request / 2s", but a short-term throttle after
// a burst of requests within one job run (e.g. every tournament's matches
// fetched back to back). One shared, more conservative client fixes all of
// them at once instead of tuning nine near-identical copies.

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";
export const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";

// Was 4 retries / 20s base (200s max wait). Confirmed via job logs this
// isn't enough for a *sustained* throttle window (as opposed to a single
// transient 429): import-team-details.mjs exhausted all 4 retries on every
// request for 6+ teams in a row in one run, each failing after ~200s
// wasted. Raised so a sustained window has more room to pass before a
// script gives up on an individual page.
const MAX_RETRIES = 6;
const RETRY_BASE_MS = 20000; // 20s, 40s, 60s, 80s, 100s, 120s

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared country/region name list — originally lived only in
// backfill-player-photos.mjs (as a flag-filename-decoding fallback), moved
// here so import-team-details.mjs can reuse it as a denylist: 11 rows in
// production had a country name ("Indonesia", "Philippines", "Malaysia")
// stored as a player's `ign`, sharing a real team_id — no active importer
// reproduces this against current Liquipedia team-page HTML (confirmed via
// a throwaway diagnostic run against 4 of the affected teams' live pages,
// every current roster row parsed to a real IGN), so the rows are leftover
// contamination from an older, already-deleted region/portal-page scraper
// (see import-team-details.mjs's header comment on what it replaced) — but
// nothing has ever stopped a similarly-shaped bug (a mis-scoped table, a
// flag/section-header row misread as a body row) from reintroducing the
// same kind of row again. Rejecting an exact country-name match at parse
// time is a cheap, permanent backstop regardless of which code path a
// future regression comes from.
export const COUNTRY_NAME_TO_CODE = {
  indonesia: "ID",
  philippines: "PH",
  malaysia: "MY",
  singapore: "SG",
  myanmar: "MM",
  cambodia: "KH",
  thailand: "TH",
  vietnam: "VN",
  laos: "LA",
  brunei: "BN",
  "east timor": "TL",
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  peru: "PE",
  colombia: "CO",
  mexico: "MX",
  bolivia: "BO",
  ecuador: "EC",
  paraguay: "PY",
  uruguay: "UY",
  venezuela: "VE",
  "dominican republic": "DO",
  "united states": "US",
  "united states of america": "US",
  canada: "CA",
  china: "CN",
  "south korea": "KR",
  japan: "JP",
  india: "IN",
  pakistan: "PK",
  bangladesh: "BD",
  nepal: "NP",
  "sri lanka": "LK",
  turkey: "TR",
  russia: "RU",
  ukraine: "UA",
  kazakhstan: "KZ",
  uzbekistan: "UZ",
  mongolia: "MN",
  "saudi arabia": "SA",
  "united arab emirates": "AE",
  kuwait: "KW",
  qatar: "QA",
  egypt: "EG",
  morocco: "MA",
  algeria: "DZ",
  tunisia: "TN",
  nigeria: "NG",
  "south africa": "ZA",
  australia: "AU",
  "new zealand": "NZ",
  england: "GB",
  "united kingdom": "GB",
  germany: "DE",
  france: "FR",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  poland: "PL",
  sweden: "SE",
};

const REQUEST_TIMEOUT_MS = 20000;

async function requestJson(url, label, attempt, maxRetries) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A stalled connection (no response at all) would otherwise hang this
    // await forever — a single bad request blocking the whole script for
    // the rest of its run, as opposed to a clean 429 which at least gets a
    // response to retry on. Treat a timeout/network error the same as a
    // retryable rate limit so one flaky request doesn't sink the run.
    if (attempt <= maxRetries) {
      const waitMs = RETRY_BASE_MS * attempt;
      console.warn(`Request stalled/failed on ${label} (${err.message}), waiting ${waitMs / 1000}s before retry ${attempt}/${maxRetries}...`);
      await sleep(waitMs);
      return null; // caller retries
    }
    throw new Error(`Liquipedia request failed for ${label}: ${err.message}`);
  }

  if (res.status === 429 && attempt <= maxRetries) {
    const waitMs = RETRY_BASE_MS * attempt;
    console.warn(`Rate limited on ${label}, waiting ${waitMs / 1000}s before retry ${attempt}/${maxRetries}...`);
    await sleep(waitMs);
    return null; // caller retries
  }
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${label}`);
  return res.json();
}

/**
 * Fetches a page's rendered HTML via action=parse, following redirects.
 * Without redirects=1, action=parse on a page that's actually a redirect
 * (e.g. an old/alternate hero or team name Liquipedia has since merged
 * into a canonical page) returns the redirect stub's own near-empty
 * content instead of the real page — no infobox, no roster table, nothing
 * to scrape, and no error either since the request itself succeeds. This
 * was confirmed as the fetch pattern to use for team pages
 * (import-team-details.mjs); applying it here too since every script
 * using this shared client can silently hit the same redirect gap.
 *
 * maxRetries defaults to the shared 6-retry/~7-minute-per-call budget, but
 * a caller that's designed to be safely re-run many times (e.g. a one-time
 * backfill over "whatever's still missing") can pass a smaller budget so a
 * *sustained* throttle window doesn't let one page eat the script's whole
 * time budget — it gives up on that page faster and makes steady partial
 * progress across the full list instead, to be mopped up on a later run.
 */
export async function fetchRenderedPage(pageTitle, attempt = 1, maxRetries = MAX_RETRIES) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");

  const data = await requestJson(url, pageTitle, attempt, maxRetries);
  if (data === null) return fetchRenderedPage(pageTitle, attempt + 1, maxRetries);
  return data.parse?.text?.["*"] ?? "";
}

/** Generic action=query helper (categorymembers, pageimages, allcategories, ...). See fetchRenderedPage's maxRetries note. */
export async function apiQuery(params, attempt = 1, maxRetries = MAX_RETRIES) {
  const url = new URL(WIKI_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");

  const label = JSON.stringify(params);
  const data = await requestJson(url, label, attempt, maxRetries);
  if (data === null) return apiQuery(params, attempt + 1, maxRetries);
  return data;
}
