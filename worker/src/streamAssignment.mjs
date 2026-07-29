import { supabase } from "./config.mjs";

/**
 * Given a stream and the team names Groq just read off the current frame,
 * figures out which scheduled match (attached to this stream) is live right
 * now. Handles requirement #2: one stream URL can cover several matches
 * back-to-back over a broadcast.
 *
 * Strategy: pull every non-finished match linked to this stream, score each
 * by how well its team names match what's visible on screen, and switch
 * `streams.current_match_id` when a different match scores clearly higher
 * than the currently assigned one.
 */
export async function resolveCurrentMatch(stream, teamNamesVisible) {
  const { data: candidates } = await supabase
    .from("matches")
    .select(
      `id, state, format, current_game_number,
       team_a:teams!matches_team_a_id_fkey(id, name),
       team_b:teams!matches_team_b_id_fkey(id, name)`
    )
    .eq("stream_id", stream.id)
    .not("state", "in", "(SERIES_FINISHED,STREAM_ENDED)")
    .order("scheduled_at", { ascending: true });

  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const visible = teamNamesVisible.map((n) => n.toLowerCase());
  function score(match) {
    let s = 0;
    if (match.team_a?.name && visible.some((v) => v.includes(match.team_a.name.toLowerCase()))) s += 1;
    if (match.team_b?.name && visible.some((v) => v.includes(match.team_b.name.toLowerCase()))) s += 1;
    return s;
  }

  const scored = candidates.map((m) => ({ match: m, score: score(m) })).sort((a, b) => b.score - a.score);
  const best = scored[0];

  // No team names legible this frame (e.g. loading screen) — stick with
  // whatever is currently assigned rather than guessing.
  if (best.score === 0) {
    return candidates.find((m) => m.id === stream.current_match_id) ?? candidates[0];
  }

  if (best.match.id !== stream.current_match_id) {
    await supabase.from("streams").update({ current_match_id: best.match.id }).eq("id", stream.id);
    if (best.match.state === "MATCH_NOT_STARTED") {
      await supabase.from("matches").update({ state: "DRAFT_STARTED", status: "live" }).eq("id", best.match.id);
    }
  }

  return best.match;
}
