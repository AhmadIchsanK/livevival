import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Full-frame AI vision analysis for the admin's local-capture live console —
// the alternative to the manual crop-region OCR (calibratingField/regions
// in app/admin/matches/[id]/live/page.tsx). Instead of the admin dragging
// pixel boxes around each element, the whole captured frame is sent here
// and a vision model reasons over it directly, returning structured JSON
// (match phase, draft picks/bans, per-player K/D/A, net worth, key
// moments). Ported from the Groq vision pipeline this project used before
// worker/ was rewritten around Liquipedia polling (see commit d9a9fe5) —
// that pipeline was dropped because it ran server-side against a
// datacenter-IP yt-dlp capture of the YouTube stream, which is exactly
// what got it bot-detected/rate-limited. This route has neither problem:
// the frame comes from the admin's own browser (getDisplayMedia on their
// own screen), so there's no scraping and no datacenter IP involved — only
// the model call itself, same shape as the code being reused.
//
// Verifies the caller is an authenticated admin via their own Supabase
// session token (same pattern as /api/telegram/notify) since this route
// has no service-role credential and spends the GROQ_API_KEY quota on
// every call.

function buildPrompt(overlayHint?: string | null) {
  return `You are watching a single frame from a Mobile Legends: Bang Bang (MLBB) \
esports broadcast. Identify what is currently on screen and respond with ONLY a \
JSON object (no markdown, no prose) matching this shape:

{
  "phase": "LOBBY | DRAFT_PICK_BAN | LOADING | IN_GAME | VICTORY_DEFEAT_SCREEN | POST_GAME_STATS | UNKNOWN",
  "game_timer_mm_ss": "string|null",   // the in-game clock, e.g. "12:34", only during IN_GAME
  "team_names_visible": ["string", ...],
  "score_visible": { "team_a": number|null, "team_b": number|null },
  "winning_team_name": "string|null",   // only if phase is VICTORY_DEFEAT_SCREEN or POST_GAME_STATS and a winner is legible
  "key_moment_banner": "SAVAGE | MANIAC | LORD_STEAL | TURTLE_STEAL | ACE | NONE",
  "key_moment_player_name": "string|null",
  "draft_actions": [ { "type": "pick|ban", "team_name": "string", "hero_name": "string" }, ... ],
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

For "player_stats": only fill this in during IN_GAME or POST_GAME_STATS when a scoreboard \
or in-game HUD showing individual K/D/A and gold per player is visible. Report every \
player row you can actually read. Use null for any individual field you can't read \
clearly (e.g. gold is visible but K/D/A isn't) rather than guessing or omitting the \
whole row. Leave the array empty if no scoreboard is visible this frame.

For "net_worth": only fill this in if a total team gold / net worth comparison is \
visible (often shown as a bar or two numbers near the top of the HUD during IN_GAME). \
Use null for either side if not legible.

Only report a phase, winner, timer, or banner if you can actually read it in the image —
use "UNKNOWN" / null / "NONE" rather than guessing.${overlayHint ? `\n\nContext for this tournament's overlay: ${overlayHint}` : ""}`;
}

// Walks the string from the first '{' and tracks brace depth, returning
// exactly the substring for ONE complete, balanced top-level JSON object —
// correctly stops at the true end of the object regardless of what
// (garbage, a second object, trailing prose) follows it.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI frame analysis isn't configured yet — set GROQ_API_KEY." },
      { status: 503 }
    );
  }
  const model = process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

  const body = await req.json().catch(() => null);
  const imageBase64: string | undefined = body?.imageBase64;
  const overlayHint: string | undefined = body?.overlayHint;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return NextResponse.json({ error: "Missing imageBase64" }, { status: 400 });
  }

  let groqRes: Response;
  try {
    groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 3000,
        reasoning_format: "hidden",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(overlayHint) },
              { type: "image_url", image_url: { url: imageBase64 } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return NextResponse.json({ error: `Groq request failed: ${(err as Error).message}` }, { status: 502 });
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return NextResponse.json({ error: `Groq API error (${groqRes.status}): ${errText}` }, { status: 502 });
  }

  const groqData = await groqRes.json();
  const raw: string = groqData.choices?.[0]?.message?.content ?? "{}";
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const extracted = extractFirstJsonObject(withoutThinking);
  if (!extracted) {
    return NextResponse.json(
      { error: `No complete JSON object in model response (${withoutThinking.slice(0, 120)})` },
      { status: 502 }
    );
  }

  try {
    const parsed = JSON.parse(extracted);
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json({ error: "Model response wasn't valid JSON" }, { status: 502 });
  }
}
