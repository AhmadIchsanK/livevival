// Fallback for a match's live-stream/VOD link when Liquipedia's own one
// isn't embeddable: the match-info popup's stream link (see
// scheduleSync.mjs's extractMatches) is a liquipedia.net
// Special:Stream/<platform>/<channel> REDIRECT page, not a direct
// youtube.com/twitch.tv URL — this app's <iframe> embed (youtubeEmbedUrl in
// both the admin live console and the public match page) can't do anything
// with that, so it silently falls back to "link not embeddable" even though
// a real, embeddable stream exists one hop away.
//
// This searches YouTube directly for a plausible replacement instead of
// following the redirect (following it would need a real HTTP client
// chasing 30x responses from inside the worker, and still might land on
// Twitch, which this app doesn't embed at all — see youtubeEmbedUrl/
// facebookEmbedUrl). "Best-effort" per the product ask: no strict
// guarantee the top result is actually the right broadcast, just a
// title/channel sanity check against the two team names.
//
// Same "not configured, log and no-op" shape as youtubeVodFallback.mjs's
// YOUTUBE_API_KEY guard (mirrors the app's other "missing key -> clear
// message, don't crash" spots, e.g. app/api/admin/refresh-liquipedia's 503).

const SEARCH_INTERVAL_MS = 60 * 60 * 1000; // don't re-search the same match more than once/hour — search.list costs 100 of the 10,000/day free-tier quota units per call, and the schedule-sync tick this lives in can run every ~30s.

let warnedMissingKey = false;
const lastAttemptAt = new Map(); // liquipedia_match_key -> timestamp, in-memory only (fine to forget on restart, just re-tries sooner)

function normalize(name) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A "real" platform URL (as opposed to a liquipedia.net redirect through
// one) — youtube.com/youtu.be is directly embeddable by this app today;
// twitch.tv isn't embedded anywhere in this app either, but is still a
// genuine direct stream link worth keeping over a redirect page. Anything
// else (liquipedia.net Special:Stream, or no link at all) is what triggers
// the fallback search below.
export function isEmbeddableStreamUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com" || host === "twitch.tv";
  } catch {
    return false;
  }
}

async function searchYoutube(query, apiKey) {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("maxResults", "5");

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`YouTube stream search failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return data.items ?? [];
}

// Best-effort sanity check, not a hard filter — a title/channel mentioning
// either team, or generic broadcast language ("live"/"vs"), is enough to
// prefer a result over the raw top hit; if nothing clears that bar, the
// literal top result is still used rather than leaving the match with no
// stream at all (per "no strict guarantee needed, best-effort").
function pickBestResult(items, teamAName, teamBName) {
  if (items.length === 0) return null;
  const a = normalize(teamAName);
  const b = normalize(teamBName);
  const plausible = items.find((item) => {
    const text = normalize(`${item.snippet?.title ?? ""} ${item.snippet?.channelTitle ?? ""}`);
    return (a && text.includes(a)) || (b && text.includes(b)) || text.includes("live") || text.includes("vs");
  });
  return plausible ?? items[0];
}

/**
 * Searches YouTube for a plausible live/VOD link for one match, using
 * roughly the first 15 characters of the tournament's title as the query
 * (per the product spec — kept short/generic since a full tournament name
 * often carries a sponsor prefix that isn't in the actual stream title).
 * Returns a youtube.com/watch?v=... URL, or null if unconfigured, rate-
 * limited (see SEARCH_INTERVAL_MS), or nothing was found.
 */
export async function findStreamFallback({ matchKey, tournamentName, teamAName, teamBName }) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.log(
        "Stream auto-import: Liquipedia gave a non-embeddable link and YOUTUBE_API_KEY isn't configured — " +
          "skipping the YouTube fallback (set YOUTUBE_API_KEY to enable it)."
      );
      warnedMissingKey = true;
    }
    return null;
  }

  const now = Date.now();
  const last = lastAttemptAt.get(matchKey) ?? 0;
  if (now - last < SEARCH_INTERVAL_MS) return null;
  lastAttemptAt.set(matchKey, now);

  const query = (tournamentName ?? "").slice(0, 15).trim();
  if (!query) return null;

  try {
    const items = await searchYoutube(query, apiKey);
    const best = pickBestResult(items, teamAName, teamBName);
    const videoId = best?.id?.videoId;
    if (!videoId) return null;
    console.log(
      `Stream auto-import: Liquipedia link wasn't embeddable — using YouTube fallback "${best.snippet?.title}" for ${teamAName} vs ${teamBName}.`
    );
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch (err) {
    console.error(`YouTube stream fallback search failed for "${query}":`, err.message);
    return null;
  }
}
