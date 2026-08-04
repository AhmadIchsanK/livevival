// Livevival — one-time cleanup: removes player rows whose `ign` is actually
// a country/region name (e.g. "Indonesia", "Philippines", "Malaysia")
// instead of a real player tag. Confirmed as 11 rows in production, all on
// real team_ids, all with role/liquipedia_slug/photo_url null (never a real
// roster entry). No currently-live Liquipedia team page reproduces this
// against import-team-details.mjs's current parsing (confirmed via a
// throwaway diagnostic GH Actions run against 4 of the affected teams) —
// these are leftover contamination from an older, already-deleted
// region/portal-page scraper (see that file's header comment on what it
// replaced). See COUNTRY_NAME_TO_CODE in _liquipedia.mjs, now also used as
// a parse-time guard in extractActiveRoster() so this can't reaccumulate.
//
// Safe to re-run: only ever touches rows still matching the country-name
// check, and repoints (never orphans) any FK reference before deleting —
// confirmed zero real references exist as of this writing (hero_picks_bans,
// player_stats, item_snapshots, key_moments, tournaments.fmvp_player_id all
// checked via SQL), but this handles it correctly regardless.

import { createClient } from "@supabase/supabase-js";
import { COUNTRY_NAME_TO_CODE } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Every column across the schema that stores a `players.id` reference.
const REFERENCING_COLUMNS = [
  { table: "hero_picks_bans", column: "player_id" },
  { table: "player_stats", column: "player_id" },
  { table: "item_snapshots", column: "player_id" },
  { table: "key_moments", column: "player_id" },
  { table: "tournaments", column: "fmvp_player_id" },
];

async function main() {
  const { data: players, error } = await supabase.from("players").select("id, ign, team_id");
  if (error) throw error;

  const bad = players.filter((p) => COUNTRY_NAME_TO_CODE[(p.ign ?? "").trim().toLowerCase()]);
  console.log(`Found ${bad.length} player row(s) whose ign is a country/region name`);

  for (const p of bad) {
    for (const { table, column } of REFERENCING_COLUMNS) {
      const { error: updErr, count } = await supabase
        .from(table)
        .update({ [column]: null }, { count: "exact" })
        .eq(column, p.id);
      if (updErr) console.error(`Failed to clear ${table}.${column} refs for ${p.id}: ${updErr.message}`);
      else if (count) console.log(`  repointed ${count} row(s) in ${table}.${column} away from ${p.id} before delete`);
    }

    const { error: delErr } = await supabase.from("players").delete().eq("id", p.id);
    if (delErr) console.error(`Failed to delete player ${p.id} (ign="${p.ign}"): ${delErr.message}`);
    else console.log(`Deleted player ${p.id} (ign="${p.ign}", team_id=${p.team_id})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
