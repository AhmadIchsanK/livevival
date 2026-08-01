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

async function tick() {
  const tournaments = await loadActiveTournaments();
  if (tournaments.length === 0) {
    console.log("No live/imminent matches this tick.");
    return;
  }
  console.log(`Polling ${tournaments.length} active tournament(s): ${tournaments.map((t) => t.name).join(", ")}`);

  for (const tournament of tournaments) {
    try {
      await syncTournamentSchedule(tournament);
      await syncTournamentFinishedMatches(tournament);
    } catch (err) {
      console.error(`Failed polling ${tournament.name}:`, err.message);
    }
  }
}

console.log(`Livevival Liquipedia poller starting (every ${config.pollIntervalSeconds}s)...`);
tick().catch((err) => console.error("Initial tick failed:", err));
setInterval(() => {
  tick().catch((err) => console.error("Tick failed:", err));
}, config.pollIntervalSeconds * 1000);
