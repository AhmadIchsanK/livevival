import { supabase, config } from "./config.mjs";

const KNOWN_TYPES = new Set(["SAVAGE", "MANIAC", "LORD_STEAL", "TURTLE_STEAL", "ACE"]);

// Avoid re-logging the same banner across consecutive frames while it's
// still on screen (a savage banner typically stays up for a few seconds,
// which at a 5s poll interval could span 2-3 frames).
const recentlyLogged = new Map(); // gameId -> { type, atMs }
const SAME_MOMENT_COOLDOWN_MS = 15_000;

export async function maybeLogKeyMoment({ game, match, detection, frameJpeg, minuteMark }) {
  const type = detection.key_moment_banner;
  if (!type || type === "NONE" || !KNOWN_TYPES.has(type)) return;

  const last = recentlyLogged.get(game.id);
  if (last && last.type === type && Date.now() - last.atMs < SAME_MOMENT_COOLDOWN_MS) return;

  let playerId = null;
  if (detection.key_moment_player_name) {
    const { data: player } = await supabase
      .from("players")
      .select("id")
      .ilike("ign", detection.key_moment_player_name)
      .maybeSingle();
    playerId = player?.id ?? null;
  }

  const screenshotUrl = await uploadScreenshot(frameJpeg, game.id, type);

  const { error } = await supabase.from("key_moments").insert({
    game_id: game.id,
    match_id: match.id,
    type: type.toLowerCase(),
    player_id: playerId,
    minute_mark: minuteMark,
    source: "auto",
    confidence: detection.confidence ?? null,
    screenshot_url: screenshotUrl,
  });

  // Unique index on (game_id, type, minute_mark) where source='auto' means
  // a duplicate insert within the same minute is silently rejected — that's
  // fine, just means our cooldown above didn't catch it in time.
  if (error && !error.message.includes("duplicate key")) {
    console.error(`Failed to log key moment (${type}) for game ${game.id}:`, error.message);
  }

  recentlyLogged.set(game.id, { type, atMs: Date.now() });
}

async function uploadScreenshot(frameJpeg, gameId, type) {
  const path = `${gameId}/${type.toLowerCase()}-${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from(config.screenshotBucket)
    .upload(path, frameJpeg, { contentType: "image/jpeg" });

  if (error) {
    console.error("Screenshot upload failed:", error.message);
    return null;
  }

  const { data } = supabase.storage.from(config.screenshotBucket).getPublicUrl(path);
  return data.publicUrl;
}
