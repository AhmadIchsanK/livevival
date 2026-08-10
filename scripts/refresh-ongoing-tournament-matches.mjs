// Livevival — closes a gap between the always-on worker (which only
// updates matches that already have a DB row) and the 6h full importer
// (which discovers new matches, but can be hours late for a specific
// tournament — either because it sits late in table order and the job
// times out before reaching it, or because it simply hasn't run yet).
//
// Concretely: a bracket page gains new match popups over the course of a
// live tournament (e.g. the Grand Final only appears once the semifinals
// resolve) — worker/'s scheduleSync.mjs deliberately skips creating rows
// for matches it doesn't already know about ("new matches are picked up by
// the 6h full importer"), so a currently-ongoing tournament can go most of
// a day without its newest matches ever reaching the database. Confirmed
// as exactly why Games of the Future 2026's Grand Final never synced: the
// tournament's last known match was two days before the final actually
// played.
//
// This runs every 30 minutes (see the paired workflow) and re-imports
// matches for ONLY tournaments currently in progress — normally 0-3 at
// once — reusing import-liquipedia-matches.mjs's exact fetch/upsert logic
// so new matches, not just status updates on existing ones, land quickly
// without waiting on the slower 6h pass.
import { createClient } from "@supabase/supabase-js";
import { importMatchesForTournament } from "./import-liquipedia-matches.mjs";
import { sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A tournament's own end_date is the last scheduled day, not necessarily
// the last moment a bracket popup could still change (Liquipedia edits
// sometimes lag the actual broadcast by a few hours) — one extra day of
// grace after end_date keeps a tournament in this fast lane through the
// day after it wraps, same idea as worker/'s recentWindowHours.
const END_DATE_GRACE_DAYS = 1;

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const graceCutoff = new Date(Date.now() - END_DATE_GRACE_DAYS * 86400_000).toISOString().slice(0, 10);

  const { data: tournaments, error } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug, start_date, end_date")
    .not("liquipedia_slug", "is", null)
    .not("start_date", "is", null)
    .lte("start_date", todayIso);
  if (error) throw error;

  const ongoing = (tournaments ?? []).filter((t) => !t.end_date || t.end_date >= graceCutoff);

  if (ongoing.length === 0) {
    console.log("No currently-ongoing tournaments to refresh.");
    return;
  }
  console.log(`Refreshing ${ongoing.length} ongoing tournament(s): ${ongoing.map((t) => t.name).join(", ")}`);

  for (const t of ongoing) {
    try {
      await importMatchesForTournament(t);
    } catch (err) {
      console.error(`Failed importing matches for ${t.name}:`, err.message);
    }
    await sleep(5000); // same inter-tournament pacing as import-liquipedia-matches.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
