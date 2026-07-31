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
  "player_stats": [
    {
      "player_name": "string",
      "team_name": "string",
      "hero_name": "string|null",
      "kills": number|null,
      "deaths": number|null,
      "assists": number|null,
      "gold": number|null
    }, ...
  ],
  "net_worth": { "team_a_gold": number|null, "team_b_gold": number|null },
  "confidence": number                    // 0.0-1.0, your own confidence in this whole reading
}

For "draft_actions": only fill this in when phase is DRAFT_PICK_BAN. List EVERY pick and \
ban currently visible on the draft board this frame — including ones locked in earlier \
that are still displayed — not just anything new. Leave it as an empty array if the draft \
board isn't on screen.

For "roster": only fill this in if you can see a lineup/loading screen showing each \
player's nickname next to the hero they're playing. Leave it as an empty array otherwise —
never guess a player name from a hero alone.

For "player_stats": only fill this in during IN_GAME or POST_GAME_STATS when a scoreboard \
or in-game HUD showing individual K/D/A and gold per player is visible. Report every \
player row you can actually read. Use null for any individual field you can't read \
clearly (e.g. gold is visible but K/D/A isn't) rather than guessing or omitting the \
whole row. Leave the array empty if no scoreboard is visible this frame.

For "net_worth": only fill this in if a total team gold / net worth comparison is \
visible (often shown as a bar or two numbers near the top of the HUD during IN_GAME). \
Use null for either side if not legible.

Only report a phase, winner, or banner if you can actually read it in the image —
use "UNKNOWN" / null / "NONE" rather than guessing.${overlayHint ? `\n\nContext for this tournament's overlay: ${overlayHint}` : ""}`;
}

async function callGroq(frameJpeg, overlayHint, attempt = 1) {
  const base64 = frameJpeg.toString("base64");

  try {
    return await groq.chat.completions.create({
      model: config.groqVisionModel,
      temperature: 0,
      max_tokens: 700,
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
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 429 && attempt <= 3) {
      const waitMs = 5000 * attempt;
      console.warn(`Groq rate limited, waiting ${waitMs / 1000}s before retry ${attempt}/3...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return callGroq(frameJpeg, overlayHint, attempt + 1);
    }
    throw err;
  }
}

/**
 * @param {Buffer} frameJpeg
 * @param {string|null} overlayHint
 * @returns {Promise<object>} parsed detection JSON
 */
export async function classifyFrame(frameJpeg, overlayHint = null) {
  const response = await callGroq(frameJpeg, overlayHint);

  const raw = response.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    // Model occasionally wraps JSON in a code fence despite instructions — strip and retry once.
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  }
}
