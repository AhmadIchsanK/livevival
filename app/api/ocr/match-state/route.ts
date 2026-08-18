import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { phaseToMatchState } from "@/lib/reconstruction/ocrBanners";
import { groqVisionModelCandidates, isGroqModelUnavailable } from "@/lib/groqVision";

// AI-vision fallback for the center match-state tracker (spec §16/§25/§27).
// The deterministic keyword OCR (detectMatchStateDetailed) is the fast path;
// when a heavily-stylized overlay OCRs as garbage it comes back empty, and the
// admin capture loop calls THIS route with just the center crop to have a
// vision model classify the phase instead. Deliberately tiny — a one-word
// answer, max_tokens 8 — so it costs almost nothing and stays well clear of the
// per-minute token limit that trips the full-frame route. It never writes
// anything: it returns a MatchState the client applies through the exact same
// suspend/finish handling as the OCR path (which still requires two consecutive
// crystal frames before finishing, so this can't finish a game on one guess).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

async function requireAdmin(req: NextRequest): Promise<{ supabase: SupabaseLike } | NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return { supabase };
}

const PROMPT = `This is a crop from the CENTER of a Mobile Legends: Bang Bang esports \
broadcast. Which one is on screen right now? Answer with ONLY one word, nothing else:
- REPLAY — an instant-replay indicator/overlay is showing
- PAUSE — a technical-pause / "please stand by" screen
- VICTORY_DEFEAT — an end-of-game VICTORY or DEFEAT banner (the base crystal just fell)
- LIVE — normal live gameplay, none of the above
Answer LIVE if you are not sure.`;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI match-state isn't configured — set GROQ_API_KEY." }, { status: 503 });
  const body = await req.json().catch(() => null);
  const imageBase64: string | undefined = body?.imageBase64;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return NextResponse.json({ error: "Missing imageBase64" }, { status: 400 });
  }

  const callModel = (model: string) =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8, // one word
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: imageBase64 } }] }],
      }),
      signal: AbortSignal.timeout(15000),
    });

  // Try each candidate vision model, falling through only when Groq reports the
  // current id is unavailable for this account (deprecated / no access / 404).
  const candidates = groqVisionModelCandidates();
  let res: Response | null = null;
  let lastStatus = 502;
  let lastErr = "";
  for (const model of candidates) {
    let r: Response;
    try {
      r = await callModel(model);
    } catch (err) {
      return NextResponse.json({ error: `Groq request failed: ${(err as Error).message}` }, { status: 502 });
    }
    if (r.status === 429) {
      // A short cooldown here isn't worth blocking the capture loop over — the
      // caller throttles its own calls and the OCR path keeps running meanwhile.
      return NextResponse.json({ state: null, phase: null, rateLimited: true });
    }
    if (r.ok) {
      res = r;
      break;
    }
    lastStatus = r.status;
    lastErr = await r.text();
    if (!isGroqModelUnavailable(r.status, lastErr)) break;
  }
  if (!res) {
    return NextResponse.json({ error: `Groq API error (${lastStatus})` }, { status: 502 });
  }

  const data = await res.json();
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  // The model returns a bare word (possibly with punctuation/quotes); the pure
  // mapper canonicalizes and only promotes explicit replay/pause/end labels.
  const state = phaseToMatchState(raw);
  return NextResponse.json({ state, phase: raw.trim().slice(0, 40) });
}
