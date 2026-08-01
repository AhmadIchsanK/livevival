import { createClient } from "@supabase/supabase-js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const supabase = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY")
);

export const config = {
  // How often the poll loop wakes up to re-check active tournaments. This is
  // the "always-on" replacement for the 10-minute refresh-imminent-matches
  // GitHub Action — a cron job can't run faster than ~5 minutes, so getting
  // meaningfully closer to real-time requires a long-running process.
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 20),
  // Matches scheduled to start within this many hours are considered
  // "imminent" and included in the fast poll even before Liquipedia marks
  // them live (brackets are sometimes a few minutes late to update).
  imminentWindowHours: Number(process.env.IMMINENT_WINDOW_HOURS ?? 2),
  // How far back a "recently started" match is still worth polling fast,
  // in case it finished without ever being marked "live" in our own table.
  recentWindowHours: Number(process.env.RECENT_WINDOW_HOURS ?? 6),
};
