// Keeps schedule/status/VOD-link fields fresh for matches this tick cares
// about. Same extraction logic as scripts/import-liquipedia-matches.mjs
// (confirmed selectors against a real api.php response), run continuously
// here instead of every 10 minutes via cron.
import * as cheerio from "cheerio";
import { supabase } from "./config.mjs";
import { fetchRenderedPage } from "./liquipediaClient.mjs";
import { notifyOnce } from "./telegram.mjs";
import { isEmbeddableStreamUrl, findStreamFallback } from "./youtubeStreamFallback.mjs";

export function parseFormat(text) {
  const m = text.match(/Bo(\d)/i);
  if (!m) return null;
  const n = m[1];
  return ["1", "2", "3", "5", "7"].includes(n) ? `BO${n}` : null;
}

// Liquipedia match-info popups link to a platform icon (Twitch/YouTube) via
// a Special:Stream redirect page while a match is live/upcoming — e.g.
// href="/mobilelegends/Special:Stream/youtube/GOTF_Official" — inside
// .match-info-links, NOT .vodlink (that only ever appears once a match is
// finished and Liquipedia has a real VOD to point to). Confirmed against a
// live fetch of the Games of the Future 2026 tournament page (GitHub
// Actions live-fetch workaround, since this sandbox can't reach
// liquipedia.net): every unfinished popup carried a .match-info-links
// entry, and every finished one had zero — the two are genuinely
// phase-exclusive, matching Liquipedia's own UI (a "watch live" button
// while a match is on, replaced by a VOD link once it wraps). The href is
// relative to liquipedia.net, so it's resolved to an absolute URL here.
function toAbsoluteLiquipediaUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, "https://liquipedia.net").href;
  } catch {
    return null;
  }
}

export function extractMatches(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $(".brkts-popup-container.brkts-match-info-popup").each((_, el) => {
    const $el = $(el);

    const timerEl = $el.find(".timer-object[data-timestamp]").first();
    const timestamp = timerEl.attr("data-timestamp");
    if (!timestamp) return;
    const finished = timerEl.attr("data-finished") === "finished";

    const leftOpponent = $el.find(".match-info-header-opponent.match-info-header-opponent-left").first();
    const rightOpponent = $el
      .find(".match-info-header-opponent")
      .not(".match-info-header-opponent-left")
      .first();

    const teamALink = leftOpponent.find("a[title]").first();
    const teamBLink = rightOpponent.find("a[title]").first();
    const teamAName = teamALink.attr("title");
    const teamBName = teamBLink.attr("title");
    if (!teamAName || !teamBName) return;

    const format = parseFormat($el.find(".match-info-header-scoreholder-lower").text());
    const vodHrefs = $el.find(".vodlink a[href]").map((_, a) => $(a).attr("href")).get();
    const streamHrefs = $el.find(".match-info-links a[href]").map((_, a) => $(a).attr("href")).get();

    matches.push({
      teamAName,
      teamBName,
      timestamp: Number(timestamp),
      finished,
      format,
      youtubeUrl: vodHrefs[0] ?? null,
      streamUrl: toAbsoluteLiquipediaUrl(streamHrefs[0]) ?? null,
    });
  });

  return matches;
}

async function findTeamId(name) {
  const { data } = await supabase.from("teams").select("id").ilike("name", name.trim()).maybeSingle();
  return data?.id ?? null;
}

async function getOrCreateStream(youtubeUrl, tournamentId, finished) {
  const { data: existing } = await supabase.from("streams").select("id").eq("url", youtubeUrl).maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("streams")
    .insert({ url: youtubeUrl, tournament_id: tournamentId, status: finished ? "ended" : "scheduled" })
    .select("id")
    .single();
  if (error) {
    console.error(`Failed to create stream for ${youtubeUrl}: ${error.message}`);
    return null;
  }
  return created.id;
}

/**
 * Refreshes schedule/status/VOD-link for one tournament's matches.
 * Skips any match with update_source = 'local_ocr' — an admin's local
 * capture session is authoritative for that match's live state, and this
 * sync must never clobber it.
 *
 * Accepts an optional pre-fetched `html` so a caller polling both this and
 * syncTournamentFinishedMatches for the same tournament in one tick (as
 * index.mjs does) can fetch the page once and reuse it for both, instead of
 * each function independently re-fetching the identical page — that
 * doubling was needlessly eating into Liquipedia's rate-limit budget. Falls
 * back to fetching it itself when called standalone.
 */
export async function syncTournamentSchedule(tournament, html) {
  const pageHtml = html ?? (await fetchRenderedPage(tournament.liquipedia_slug));
  const found = extractMatches(pageHtml);

  for (const m of found) {
    const teamAId = await findTeamId(m.teamAName);
    const teamBId = await findTeamId(m.teamBName);
    if (!teamAId || !teamBId) continue; // unknown team — the slow 6h importer will create it

    const key = `${tournament.liquipedia_slug}__${teamAId}__${teamBId}__${m.timestamp}`;

    const { data: existing } = await supabase
      .from("matches")
      .select("id, status, update_source, notification_tier, stream:streams!matches_stream_id_fkey(url)")
      .eq("liquipedia_match_key", key)
      .maybeSingle();

    if (!existing) continue; // new matches are picked up by the 6h full importer
    if (existing.update_source === "local_ocr") continue; // admin capture owns this match

    // VOD link takes priority once a match is finished (it's the permanent,
    // on-demand link); the live-stream link takes priority beforehand,
    // since a VOD generally doesn't exist yet at that point. Either one is
    // "the" stream link when only one is present.
    let linkUrl = m.finished ? m.youtubeUrl ?? m.streamUrl : m.streamUrl ?? m.youtubeUrl;

    // Liquipedia's match-info stream link is a liquipedia.net
    // Special:Stream/<platform>/<channel> redirect page, not a direct
    // youtube.com/twitch.tv URL — not embeddable as-is (see
    // youtubeStreamFallback.mjs). Falls back to a best-effort YouTube
    // search instead, unless a genuinely embeddable link is already
    // attached (skip re-searching every tick once that's resolved).
    if (linkUrl && !isEmbeddableStreamUrl(linkUrl) && !isEmbeddableStreamUrl(existing.stream?.url)) {
      const fallbackUrl = await findStreamFallback({
        matchKey: key,
        tournamentName: tournament.name,
        teamAName: m.teamAName,
        teamBName: m.teamBName,
      });
      if (fallbackUrl) linkUrl = fallbackUrl;
    }

    let streamId = null;
    if (linkUrl) streamId = await getOrCreateStream(linkUrl, tournament.id, m.finished);

    const payload = {};
    if (m.format) payload.format = m.format;
    if (streamId) payload.stream_id = streamId;
    // Never downgrade a match already flagged finished/live by the detail sync this same tick.
    if (existing.status !== "live" && existing.status !== "finished") {
      payload.status = m.finished ? "finished" : Date.now() >= m.timestamp * 1000 ? "live" : "scheduled";
    }

    if (Object.keys(payload).length > 0) {
      const { error } = await supabase.from("matches").update(payload).eq("id", existing.id);
      if (error) console.error(`Failed to update match schedule: ${error.message}`);
    }

    // notification_tier (a separate axis from update_source — see the
    // migration and worker/README) gates every automatic notification
    // below: 'normal' (the default) sends none at all, 'priority' and
    // 'hot' both get exactly one "match started" post the moment a match
    // flips scheduled -> live, stream link included if one's known yet.
    // The old unconditional 15-minute-before reminder is retired in favor
    // of this — neither tier the spec calls for wants it (Priority
    // explicitly not; Hot never had it, since Hot matches were always
    // local_ocr and skipped by this function entirely until tiers existed).
    const tier = existing.notification_tier ?? "normal";
    if (payload.status === "live" && existing.status === "scheduled" && tier !== "normal") {
      await notifyOnce(
        "match",
        existing.id,
        "match_live",
        `🔴 <b>LIVE NOW</b>\n${m.teamAName} vs ${m.teamBName}\n${tournament.name}` +
          (linkUrl ? `\n${linkUrl}` : "")
      );
    }
  }

  return found;
}
