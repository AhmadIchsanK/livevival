import { supabase } from "./config.mjs";

function resolveTeamId(name, teamA, teamB) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (teamA?.name && n.includes(teamA.name.toLowerCase())) return teamA.id;
  if (teamB?.name && n.includes(teamB.name.toLowerCase())) return teamB.id;
  return null;
}

// Draft boards stay on screen for a while, so the model reports the FULL
// current board every frame, not just what's new. We just try to insert
// everything it sees; a unique constraint on (game_id, team_id, hero_name,
// type) silently rejects anything already logged, so re-reporting the same
// pick across many frames is harmless.
export async function maybeLogDraftActions({ game, teamA, teamB, detection }) {
  const actions = detection.draft_actions;
  if (!Array.isArray(actions) || actions.length === 0) return;

  for (const action of actions) {
    if (!action?.hero_name || !action?.type) continue;
    const teamId = resolveTeamId(action.team_name, teamA, teamB);
    if (!teamId) continue;

    const { error } = await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      match_id: game.match_id,
      team_id: teamId,
      hero_name: action.hero_name,
      type: action.type === "ban" ? "ban" : "pick",
    });

    if (error && !error.message.includes("duplicate key")) {
      console.error(`Failed to log draft action (${action.type} ${action.hero_name}):`, error.message);
    }
  }
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

// Fills in which player is on which hero, read straight off the loading
// screen — this is what makes the draft recap show a name, not just a hero.
export async function maybeLogRoster({ game, teamA, teamB, detection }) {
  const roster = detection.roster;
  if (!Array.isArray(roster) || roster.length === 0) return;

  for (const entry of roster) {
    if (!entry?.player_name || !entry?.hero_name) continue;
    const teamId = resolveTeamId(entry.team_name, teamA, teamB);
    if (!teamId) continue;

    const playerId = await getOrCreatePlayer(entry.player_name, teamId);
    if (!playerId) continue;

    const { error } = await supabase
      .from("player_stats")
      .upsert(
        { game_id: game.id, match_id: game.match_id, player_id: playerId, hero_name: entry.hero_name },
        { onConflict: "game_id,player_id" }
      );
    if (error) console.error(`Failed to upsert player_stats for ${entry.player_name}:`, error.message);
  }
}
