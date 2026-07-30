import "dotenv/config";
import { supabase, config } from "./config.mjs";
import { captureFrame } from "./frameCapture.mjs";
import { classifyFrame } from "./groqVision.mjs";
import { applyDetection } from "./stateMachine.mjs";
import { resolveCurrentMatch } from "./streamAssignment.mjs";
import { maybeLogKeyMoment } from "./keyMoments.mjs";
import { maybeLogDraftActions, maybeLogRoster } from "./draftTracking.mjs";

const streamTimers = new Map(); // streamId -> interval handle

async function loadActiveStreams() {
  const { data } = await supabase
    .from("streams")
    .select("id, url, platform, overlay_template, status, current_match_id, poll_interval_seconds")
    .in("status", ["scheduled", "live"]);
  return data ?? [];
}

async function tick(stream) {
  try {
    const frame = await captureFrame(stream.url);
    const detection = await classifyFrame(frame, stream.overlay_template === "default" ? null : stream.overlay_template);

    await supabase.from("vision_detections").insert({
      stream_id: stream.id,
      detected_phase: detection.phase,
      detected_payload: detection,
    });

    if (detection.phase === "LOBBY" || detection.phase === "UNKNOWN") {
      return; // nothing actionable this frame
    }

    // Mark the stream live the first time we see actual match content.
    if (stream.status === "scheduled") {
      await supabase.from("streams").update({ status: "live" }).eq("id", stream.id);
    }

    const match = await resolveCurrentMatch(stream, detection.team_names_visible ?? []);
    if (!match) return; // no matches scheduled against this stream yet

    // Skip matches the admin has taken manual control of (auto_managed = false).
    const { data: matchRow } = await supabase
      .from("matches")
      .select(
        `id, format, current_game_number, state, auto_managed,
         team_a:teams!matches_team_a_id_fkey(id, name),
         team_b:teams!matches_team_b_id_fkey(id, name)`
      )
      .eq("id", match.id)
      .single();
    if (!matchRow || matchRow.auto_managed === false) return;

    let { data: game } = await supabase
      .from("games")
      .select("*")
      .eq("match_id", matchRow.id)
      .eq("game_number", matchRow.current_game_number)
      .maybeSingle();

    if (!game) {
      const { data: created } = await supabase
        .from("games")
        .insert({ match_id: matchRow.id, game_number: matchRow.current_game_number })
        .select("*")
        .single();
      game = created;
    }

    await applyDetection({ match: matchRow, game, detection });
    await maybeLogDraftActions({ game, teamA: matchRow.team_a, teamB: matchRow.team_b, detection });
    await maybeLogRoster({ game, teamA: matchRow.team_a, teamB: matchRow.team_b, detection });

    const minuteMark = game.started_at
      ? Math.floor((Date.now() - new Date(game.started_at).getTime()) / 60000)
      : null;
    await maybeLogKeyMoment({ game, match: matchRow, detection, frameJpeg: frame, minuteMark });
  } catch (err) {
    console.error(`[stream ${stream.id}] tick failed:`, err.message);
  }
}

function scheduleStream(stream) {
  if (streamTimers.has(stream.id)) return; // already scheduled

  const intervalSeconds =
    stream.status === "live" ? config.pollIntervalLiveSeconds : config.pollIntervalIdleSeconds;

  const handle = setInterval(() => tick(stream), intervalSeconds * 1000);
  streamTimers.set(stream.id, handle);
  console.log(`Scheduled stream ${stream.id} (${stream.status}) every ${intervalSeconds}s`);
}

async function reconcileStreams() {
  const active = await loadActiveStreams();
  console.log(`reconcileStreams: found ${active.length} active stream(s)`);
  const activeIds = new Set(active.map((s) => s.id));

  // Stop watching streams that ended or were removed.
  for (const [id, handle] of streamTimers.entries()) {
    if (!activeIds.has(id)) {
      clearInterval(handle);
      streamTimers.delete(id);
      console.log(`Stopped watching stream ${id} (no longer active)`);
    }
  }

  for (const stream of active) scheduleStream(stream);
}

console.log("Livevival worker starting...");
reconcileStreams().catch((err) => console.error("Initial reconcileStreams failed:", err));
// Re-check the list of active streams periodically in case an admin adds
// a new one or marks one "ended" — no restart needed.
setInterval(() => {
  reconcileStreams().catch((err) => console.error("reconcileStreams failed:", err));
}, 60_000);
