// Keeps schedule/status/VOD-link fields fresh for matches this tick cares
// about. Same extraction logic as scripts/import-liquipedia-matches.mjs
// (confirmed selectors against a real api.php response), run continuously
// here instead of every 10 minutes via cron.
import * as cheerio from "cheerio";
import { supabase } from "./config.mjs";
import { fetchRenderedPage } from "./liquipediaClient.mjs";
import { notifyOnce } from "./telegram.mjs";

export function parseFormat(text) {
  const m = text.match(/Bo(\d)/i);
  if (!m) return null;
  const n = m[1];
  return ["1", "2", "3", "5", "7"].includes(n) ? `BO${n}` : null;
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

    matches.push({
      teamAName,
      teamBName,
      timestamp: Number(timestamp),
      finished,
      format,
      youtubeUrl: vodHrefs[0] ?? null,
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
 */
export async function syncTournamentSchedule(tournament) {
  const html = await fetchRenderedPage(tournament.liquipedia_slug);
  const found = extractMatches(html);

  for (const m of found) {
    const teamAId = await findTeamId(m.teamAName);
    const teamBId = await findTeamId(m.teamBName);
    if (!teamAId || !teamBId) continue; // unknown team — the slow 6h importer will create it

    const key = `${tournament.liquipedia_slug}__${teamAId}__${teamBId}__${m.timestamp}`;

    const { data: existing } = await supabase
      .from("matches")
      .select("id, status, update_source")
      .eq("liquipedia_match_key", key)
      .maybeSingle();

    if (!existing) continue; // new matches are picked up by the 6h full importer
    if (existing.update_source === "local_ocr") continue; // admin capture owns this match

    let streamId = null;
    if (m.youtubeUrl) streamId = await getOrCreateStream(m.youtubeUrl, tournament.id, m.finished);

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

    if (payload.status === "live" && existing.status === "scheduled") {
      await notifyOnce(
        "match",
        existing.id,
        "match_live",
        `🔴 <b>LIVE NOW</b>\n${m.teamAName} vs ${m.teamBName}\n${tournament.name}` +
          (m.youtubeUrl ? `\n${m.youtubeUrl}` : "")
      );
    }

    // "Upcoming match" reminder — fires once, for matches still scheduled
    // and starting within the next 15 minutes. Uses the same
    // notifyOnce/telegram_notifications dedup as every other notification
    // type, so it's safe to re-evaluate on every tick without spamming.
    const minutesUntilStart = (m.timestamp * 1000 - Date.now()) / 60000;
    if (!m.finished && existing.status === "scheduled" && minutesUntilStart > 0 && minutesUntilStart <= 15) {
      await notifyOnce(
        "match",
        existing.id,
        "match_reminder",
        `⏰ <b>Starting soon</b> (~${Math.max(1, Math.round(minutesUntilStart))} min)\n${m.teamAName} vs ${m.teamBName}\n${tournament.name}`
      );
    }
  }

  return found;
}
