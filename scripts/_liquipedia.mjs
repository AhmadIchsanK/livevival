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

// Coarser geographic/competitive grouping derived from a COUNTRY_NAME_TO_CODE
// country code — used to fill teams.region from teams.location when a
// team's Liquipedia infobox has no explicit "Region" field of its own
// (unlike tournament/hero infoboxes, team infoboxes typically don't list
// one directly). Deliberately mirrors the shape of the two example values
// already documented on the region column itself (see
// add_team_social_location_fields.sql's comment: "Indonesia", "Philippines",
// "MENA") — single-country MLBB markets big enough to run their own
// national league keep their own name as their region, everything else
// groups into a widely-recognized geographic bloc. This is a deterministic
// function of the scraped location, not a per-team guess, and it only ever
// fills teams.region when that column is still null — an admin can always
// override it by hand afterward (see import-team-details.mjs's needsFetch/
// "only fill a gap" pattern). Extend as real gaps turn up rather than
// guessing entries for countries with no scraped team location yet.
export const REGION_BY_COUNTRY_CODE = {
  ID: "Indonesia",
  PH: "Philippines",
  MY: "Malaysia",
  SG: "Singapore",
  BN: "Brunei",
  MM: "Myanmar",
  KH: "Cambodia",
  TH: "Thailand",
  VN: "Vietnam",
  LA: "Laos",
  TL: "Southeast Asia",
  SA: "MENA",
  AE: "MENA",
  KW: "MENA",
  QA: "MENA",
  EG: "MENA",
  MA: "MENA",
  DZ: "MENA",
  TN: "MENA",
  TR: "MENA",
  BR: "Latin America",
  AR: "Latin America",
  CL: "Latin America",
  PE: "Latin America",
  CO: "Latin America",
  MX: "Latin America",
  BO: "Latin America",
  EC: "Latin America",
  PY: "Latin America",
  UY: "Latin America",
  VE: "Latin America",
  DO: "Latin America",
  US: "North America",
  CA: "North America",
  CN: "East Asia",
  KR: "East Asia",
  JP: "East Asia",
  IN: "South Asia",
  PK: "South Asia",
  BD: "South Asia",
  NP: "South Asia",
  LK: "South Asia",
  RU: "CIS",
  UA: "CIS",
  KZ: "CIS",
  UZ: "CIS",
  MN: "CIS",
  AU: "Oceania",
  NZ: "Oceania",
  GB: "Europe",
  DE: "Europe",
  FR: "Europe",
  ES: "Europe",
  PT: "Europe",
  IT: "Europe",
  PL: "Europe",
  SE: "Europe",
  NG: "Africa",
  ZA: "Africa",
};

// Confirmed against real rendered HTML for 5 players (see
// backfill-player-photos.mjs's header comment) — a nationality/location
// value's flag <img> src encodes the ISO code in its filename
// ("Ar_hd.png" = AR, "Id_hd.png" = ID, ...). Shared here since both
// backfill-player-photos.mjs (player nationality) and
// import-team-details.mjs (team location, for deriving region) read a
// flag-bearing infobox value cell the same way.
export const FLAG_CODE_RE = /\/([A-Za-z]{2})_hd\.png/;

/** Reads every flag icon inside an infobox value cell, returning ISO codes (falls back to COUNTRY_NAME_TO_CODE via the flag's alt/title when the filename doesn't follow the standard pattern). Returns null if the cell has no flag at all. */
export function extractCountryCodes($, valueCell) {
  const codes = [];
  valueCell.find("span.flag img").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src") || "";
    const match = src.match(FLAG_CODE_RE);
    let code = match ? match[1].toUpperCase() : null;
    const flagName = ($img.attr("alt") || $img.attr("title") || "").trim();
    if (!code && flagName) {
      code = COUNTRY_NAME_TO_CODE[flagName.toLowerCase()] || null;
      if (!code) console.warn(`  unrecognized flag "${flagName}" (src: ${src}) — add it to COUNTRY_NAME_TO_CODE`);
    }
    if (code) codes.push(code);
  });
  return codes.length > 0 ? Array.from(new Set(codes)) : null;
}

/** Maps every `<label>: value` infobox row (the `.infobox-description` / next-sibling pattern used across player, team, hero, etc. infoboxes) by lowercased label text, e.g. rows.get("location"). */
export function getInfoboxRows($) {
  const rows = new Map();
  $(".infobox-description").each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, "").toLowerCase();
    rows.set(label, $(el).next());
  });
  return rows;
}

/**
 * Reads Liquipedia's icon-based links block — confirmed (see
 * backfill-player-photos.mjs's header comment) as
 * `.infobox-icons a[href]` wrapping an `<i class="lp-icon lp-<platform>">`,
 * one anchor per platform, on player pages; team pages use the same
 * Module:Links-based markup for their own "Links" section. Returns a
 * {platform: href} map keyed by the icon's own lp-* class name (e.g.
 * "instagram", "twitter", "discord") — callers that need specific DB
 * columns (see import-team-details.mjs's extractSocialLinks) reclassify
 * from there, since a bare platform key isn't guaranteed to line up with
 * any particular schema's column names.
 */
export function extractInfoboxIconLinks($) {
  const links = {};
  $(".infobox-icons a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    const iconClasses = ($a.find("i").first().attr("class") || "").split(/\s+/);
    const platformClass = iconClasses.find((c) => c.startsWith("lp-") && c !== "lp-icon");
    const platform = platformClass ? platformClass.replace(/^lp-/, "") : null;
    if (platform) links[platform] = href;
  });
  return Object.keys(links).length > 0 ? links : null;
}

// Lifecycle-priority ordering for the tournament walk in the match/detail
// importers. Both jobs process tournaments sequentially with a hard timeout
// and NO resume state, so whichever tournaments sit late in the list simply
// never get processed when a run is cancelled mid-walk (confirmed in prod:
// the import-matches job is cancelled at its 75-min timeout every single run,
// so a current season's just-played matches sat "scheduled" with no result
// for days because the walk never reached/re-reached them in time). Table
// order is arbitrary, so ordering by lifecycle puts the tournaments whose
// data is actually changing right now (ongoing, then imminent upcoming, then
// most-recently-completed) at the front — directly implementing the product
// priority "update live/finished match results, URLs, picks & bans first".
export function tournamentPriorityRank(t, now = Date.now()) {
  const start = t.start_date ? new Date(t.start_date).getTime() : null;
  const end = t.end_date ? new Date(t.end_date).getTime() : null;
  // Ongoing: has started and hasn't ended (or has no known end yet).
  if (start != null && start <= now && (end == null || end >= now)) return 0;
  // Upcoming: starts in the future.
  if (start != null && start > now) return 1;
  // Completed, or dates unknown — lowest priority (the long tail).
  return 2;
}

export function sortByLifecyclePriority(tournaments, now = Date.now()) {
  return [...tournaments].sort((a, b) => {
    const ra = tournamentPriorityRank(a, now);
    const rb = tournamentPriorityRank(b, now);
    if (ra !== rb) return ra - rb;
    const aStart = a.start_date ? new Date(a.start_date).getTime() : 0;
    const bStart = b.start_date ? new Date(b.start_date).getTime() : 0;
    const aEnd = a.end_date ? new Date(a.end_date).getTime() : Infinity;
    const bEnd = b.end_date ? new Date(b.end_date).getTime() : Infinity;
    // Ongoing: soonest-ending first (closest to producing final results).
    if (ra === 0) return aEnd - bEnd;
    // Upcoming: soonest-starting first.
    if (ra === 1) return aStart - bStart;
    // Completed/unknown: most-recently-ended (then -started) first.
    return bEnd - aEnd || bStart - aStart;
  });
}

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
