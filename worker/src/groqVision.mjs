import Groq from "groq-sdk";
import { config } from "./config.mjs";

const groq = new Groq({ apiKey: config.groqApiKey });

// Kept overlay-agnostic on purpose (requirement #9): instead of hardcoding
// pixel regions for one tournament's HUD, we ask the model to reason over
// the whole frame and return structured JSON. `overlayHint` lets you pass a
// short, tournament-specific note (e.g. "kill banners appear top-center in
// yellow text") for layouts that trip up the default prompt.
function buildPrompt(overlayHint) {
  return `You are watching a single frame from a Mobile Legends: Bang Bang (MLBB) \
esports broadcast. Identify what is currently on screen and respond with ONLY a \
JSON object (no markdown, no prose) matching this shape:

{
  "phase": "LOBBY | DRAFT_PICK_BAN | LOADING | IN_GAME | VICTORY_DEFEAT_SCREEN | POST_GAME_STATS | UNKNOWN",
  "team_names_visible": ["string", ...],
  "score_visible": { "team_a": number|null, "team_b": number|null },
  "winning_team_name": "string|null",   // only if phase is VICTORY_DEFEAT_SCREEN or POST_GAME_STATS and a winner is legible
  "key_moment_banner": "SAVAGE | MANIAC | LORD_STEAL | TURTLE_STEAL | ACE | NONE",
  "key_moment_player_name": "string|null",
  "draft_actions": [ { "type": "pick|ban", "team_name": "string", "hero_name": "string" }, ... ],
  "roster": [ { "team_name": "string", "player_name": "string", "hero_name": "string" }, ... ],
  "confidence": number                    // 0.0-1.0, your own confidence in this whole reading
}

For "draft_actions": only fill this in when phase is DRAFT_PICK_BAN. List EVERY pick and \
ban currently visible on the draft board this frame — including ones locked in earlier \
that are still displayed — not just anything new. Leave it as an empty array if the draft \
board isn't on screen.

For "roster": only fill this in if you can see a lineup/loading screen showing each \
player's nickname next to the hero they're playing. Leave it as an empty array otherwise —
never guess a player name from a hero alone.

Only report a phase, winner, or banner if you can actually read it in the image —
use "UNKNOWN" / null / "NONE" rather than guessing.${overlayHint ? `\n\nContext for this tournament's overlay: ${overlayHint}` : ""}`;
}

/**
 * @param {Buffer} frameJpeg
 * @param {string|null} overlayHint
 * @returns {Promise<object>} parsed detection JSON
 */
export async function classifyFrame(frameJpeg, overlayHint = null) {
  const base64 = frameJpeg.toString("base64");

  const response = await groq.chat.completions.create({
    model: config.groqVisionModel,
    temperature: 0,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(overlayHint) },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    // Model occasionally wraps JSON in a code fence despite instructions — strip and retry once.
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  }
}
