import "dotenv/config";
import { supabase, config } from "./config.mjs";
import { syncTournamentSchedule } from "./scheduleSync.mjs";
import { syncTournamentFinishedMatches } from "./finishedMatchSync.mjs";

// Always-on replacement for the 10-minute refresh-imminent-matches GitHub
// Action: GitHub Actions cron cannot run faster than ~5 minutes, so getting
// close to real-time for a match that's live or about to start requires a
// long-running process. This polls only the tournaments that currently have
// a live or imminent match — everything else (new tournaments, historical
// backfill, team/hero rosters) stays on the slower 6-hour cron.
async function loadActiveTournaments() {
  const now = new Date();
  const imminentCutoff = new Date(now.getTime() + config.imminentWindowHours * 3600_000).toISOString();
  const recentCutoff = new Date(now.getTime() - config.recentWindowHours * 3600_000).toISOString();

  const { data: matches, error } = await supabase
    .from("matches")
    .select("tournament_id, status, update_source, scheduled_at, tournaments(id, liquipedia_slug, name)")
    .eq("update_source", "liquipedia")
    .neq("status", "finished")
    .gte("scheduled_at", recentCutoff)
    .lte("scheduled_at", imminentCutoff);

  if (error) {
    console.error("Failed to load active matches:", error.message);
    return [];
  }

  const byId = new Map();
  for (const m of matches ?? []) {
    const t = m.tournaments;
    if (t?.liquipedia_slug && !byId.has(t.id)) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

// Cooldown after a rate-limited tournament, keyed by tournament id. Without
// this, a single 429 gets retried inside the same tick (up to ~200s of
// backoff in liquipediaClient.mjs) and then the very next tick — which
// fires on its own timer regardless of how long the last one took — retries
// it again immediately, so the same page gets hammered continuously and
// Liquipedia's throttle window never gets a chance to actually reset.
const COOLDOWN_MS = 5 * 60 * 1000;
const rateLimitedUntil = new Map(); // tournamentId -> timestamp

async function tick() {
  const tournaments = await loadActiveTournaments();
  if (tournaments.length === 0) {
    console.log("No live/imminent matches this tick.");
    return;
  }

  const now = Date.now();
  const due = tournaments.filter((t) => (rateLimitedUntil.get(t.id) ?? 0) <= now);
  const skipped = tournaments.length - due.length;
  console.log(
    `Polling ${due.length} active tournament(s): ${due.map((t) => t.name).join(", ")}` +
      (skipped > 0 ? ` (${skipped} still cooling down after a rate limit)` : "")
  );

  for (const tournament of due) {
    try {
      await syncTournamentSchedule(tournament);
      await syncTournamentFinishedMatches(tournament);
    } catch (err) {
      console.error(`Failed polling ${tournament.name}:`, err.message);
      if (err.message.includes("429")) {
        rateLimitedUntil.set(tournament.id, Date.now() + COOLDOWN_MS);
        console.warn(`Cooling down ${tournament.name} for ${COOLDOWN_MS / 1000}s after a rate limit.`);
      }
    }
  }
}

// Self-scheduling loop instead of setInterval: a tick only gets queued
// after the previous one fully resolves, so a slow/retrying tick (which can
// take minutes once Liquipedia rate-limits it) can never overlap with the
// next one hammering the same page concurrently.
let stopped = false;
async function loop() {
  while (!stopped) {
    try {
      await tick();
    } catch (err) {
      console.error("Tick failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalSeconds * 1000));
  }
}

console.log(`Livevival Liquipedia poller starting (every ${config.pollIntervalSeconds}s)...`);
loop();
