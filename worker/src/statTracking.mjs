import { supabase } from "./config.mjs";

function resolveTeamId(name, teamA, teamB) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (teamA?.name && n.includes(teamA.name.toLowerCase())) return teamA.id;
  if (teamB?.name && n.includes(teamB.name.toLowerCase())) return teamB.id;
  return null;
}

async function getOrCreatePlayer(ign, teamId) {
  const { data: existing } = await supabase
    .from("players")
    .select("id")
    .eq("team_id", teamId)
    .ilike("ign", ign.trim())
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("players")
    .insert({ ign: ign.trim(), team_id: teamId })
    .select("id")
    .single();
  if (error) {
    console.error(`Failed to create player "${ign}":`, error.message);
    return null;
  }
  return created.id;
}

// Only overwrites a field when the model actually read it this frame (not
// null) — so one blurry frame where gold is legible but K/D/A isn't doesn't
// wipe out a previously-read K/D/A. Only ever moves forward, never backward:
// a stat never decreases mid-game in MLBB, so if a later (blurrier) frame
// reports a lower number than what we already have, keep the higher one.
export async function maybeLogPlayerStats({ game, teamA, teamB, detection }) {
  const rows = detection.player_stats;
  if (!Array.isArray(rows) || rows.length === 0) return;

  for (const row of rows) {
    if (!row?.player_name) continue;
    const teamId = resolveTeamId(row.team_name, teamA, teamB);
    if (!teamId) continue;

    const playerId = await getOrCreatePlayer(row.player_name, teamId);
    if (!playerId) continue;

    const { data: existing } = await supabase
      .from("player_stats")
      .select("kills, deaths, assists, gold, hero_name")
      .eq("game_id", game.id)
      .eq("player_id", playerId)
      .maybeSingle();

    const merged = {
      game_id: game.id,
      match_id: game.match_id,
      player_id: playerId,
      hero_name: row.hero_name ?? existing?.hero_name ?? null,
      kills: Math.max(row.kills ?? 0, existing?.kills ?? 0),
      deaths: Math.max(row.deaths ?? 0, existing?.deaths ?? 0),
      assists: Math.max(row.assists ?? 0, existing?.assists ?? 0),
      gold: Math.max(row.gold ?? 0, existing?.gold ?? 0),
    };

    const { error } = await supabase
      .from("player_stats")
      .upsert(merged, { onConflict: "game_id,player_id" });
    if (error) console.error(`Failed to upsert stats for ${row.player_name}:`, error.message);
  }
}

// One net-worth snapshot per detection tick — the public page's gold-diff
// chart plots these over time, so more points (even close together) is fine.
export async function maybeLogNetWorth({ game, detection, minuteMark }) {
  const nw = detection.net_worth;
  if (!nw || (nw.team_a_gold == null && nw.team_b_gold == null)) return;

  const { error } = await supabase.from("net_worth_snapshots").insert({
    game_id: game.id,
    minute_mark: minuteMark ?? 0,
    team_a_gold: nw.team_a_gold ?? 0,
    team_b_gold: nw.team_b_gold ?? 0,
  });
  if (error) console.error("Failed to log net worth snapshot:", error.message);
}
