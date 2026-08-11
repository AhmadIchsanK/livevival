import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// AI-suggested tracker layout — the admin takes one screenshot of the
// current capture (already-fullscreened broadcast, same frame the manual
// calibration canvas shows), a vision model finds where each standard HUD
// element sits, and the client (app/admin/matches/[id]/live/page.tsx,
// suggestLayoutFromScreenshot) turns the response straight into
// addTrackerWithRegion calls — same "never touches a field that's already
// tracked" contract as Auto-place/Apply-template, just sourced from a
// vision read of THIS broadcast's actual layout instead of a generic
// hardcoded guess or a previously-saved template. Existing calibration is
// still hand-adjustable afterward exactly like any other tracker box; this
// only ever proposes a starting point, it's not a live re-detection loop.
//
// Reuses the same auth/Groq-vision pattern as /api/ocr/analyze-frame
// (bearer-token admin check, image_url content block, extractFirstJsonObject
// for robust parsing) — deliberately a separate route rather than a mode
// flag on that one, since the response shape (a list of named boxes) is
// unrelated to that route's per-frame game-state detection shape, and this
// one never writes anything itself — the client reviews/places every
// suggested box the same way a hand-drawn one would be.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any; // no generated Database types wired up for this route; matches analyze-frame/route.ts

// Fixed field keys the client already knows how to turn into a tracker
// (see FIELD_TO_TRACKER in page.tsx) — the model is told to use exactly
// these, not free-form names, so there's no fuzzy-matching step needed on
// the way back in.
const KNOWN_FIELDS = [
  "game_timer",
  "kill_banner",
  "net_worth_left",
  "net_worth_right",
  "team_kills_left",
  "team_kills_right",
  "objectives_group_left",
  "objectives_group_right",
  "kda_group_left",
  "kda_group_right",
] as const;

function buildPrompt() {
  return `You are looking at one frame of a Mobile Legends: Bang Bang (MLBB) esports \
broadcast HUD. Find the on-screen position of each of the following elements, if it is \
actually visible in this image. Respond with ONLY a JSON object (no markdown, no prose) \
of this shape:

{
  "regions": [
    { "field": "one of the exact field keys below", "x_pct": number, "y_pct": number, "w_pct": number, "h_pct": number, "confidence": number }
  ]
}

x_pct/y_pct is the top-left corner of a tight bounding box around the element, w_pct/h_pct \
is its width/height — all four as a percentage (0-100) of the FULL image width/height. \
confidence is your own 0.0-1.0 confidence in that specific box.

Only include an entry for a field you can actually see and locate — omit anything not \
visible or you're unsure about, rather than guessing a position. Use ONLY these exact \
field keys, each at most once:

- "game_timer" — the running game clock (MM:SS), usually top-center.
- "kill_banner" — where a SAVAGE/MANIAC/kill-streak banner would appear, usually center screen.
- "net_worth_left" / "net_worth_right" — each team's total net worth / gold number, usually near the top corners.
- "team_kills_left" / "team_kills_right" — each team's total kill count, usually near their team name/score.
- "objectives_group_left" / "objectives_group_right" — a TIGHT box around each team's whole \
tower + lord + turtle icon-and-count cluster (all 3 icons and their numbers together, not \
just one).
- "kda_group_left" / "kda_group_right" — a box spanning ALL 5 players' K/D/A rows for that \
team as one column (portraits + kill/death/assist numbers for every player on that side, \
top to bottom), not just one player's row.

"left"/"right" mean the physical left/right side of the screen as shown in this image, not \
a specific team name.`;
}

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

async function requireAdmin(req: NextRequest): Promise<{ supabase: SupabaseLike } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return { supabase };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI layout suggestions aren't configured yet — set GROQ_API_KEY." }, { status: 503 });
  }
  const model = process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

  const body = await req.json().catch(() => null);
  const imageBase64: string | undefined = body?.imageBase64;
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
        max_tokens: 1500,
        reasoning_format: "hidden",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt() },
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
    return NextResponse.json({ error: `No complete JSON object in model response (${withoutThinking.slice(0, 120)})` }, { status: 502 });
  }

  let parsed: { regions?: unknown };
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return NextResponse.json({ error: "Model response wasn't valid JSON" }, { status: 502 });
  }

  // Defensive validation — this response drives real writes (tracker
  // regions) once the client applies it, so a malformed/hallucinated
  // entry gets dropped here rather than trusted through: an unknown field
  // name, an out-of-range percentage, or a box no OCR could ever use are
  // all filtered out before the client sees them.
  const rawRegions = Array.isArray(parsed.regions) ? parsed.regions : [];
  const regions = rawRegions
    .map((r) => r as Record<string, unknown>)
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      field: typeof r.field === "string" ? r.field : null,
      x_pct: typeof r.x_pct === "number" ? r.x_pct : null,
      y_pct: typeof r.y_pct === "number" ? r.y_pct : null,
      w_pct: typeof r.w_pct === "number" ? r.w_pct : null,
      h_pct: typeof r.h_pct === "number" ? r.h_pct : null,
      confidence: typeof r.confidence === "number" ? r.confidence : null,
    }))
    .filter(
      (r) =>
        r.field &&
        (KNOWN_FIELDS as readonly string[]).includes(r.field) &&
        r.x_pct != null &&
        r.y_pct != null &&
        r.w_pct != null &&
        r.h_pct != null &&
        r.w_pct > 0.5 &&
        r.h_pct > 0.5 &&
        r.x_pct >= 0 &&
        r.y_pct >= 0 &&
        r.x_pct + r.w_pct <= 100.5 &&
        r.y_pct + r.h_pct <= 100.5
    );

  return NextResponse.json({ regions });
}
