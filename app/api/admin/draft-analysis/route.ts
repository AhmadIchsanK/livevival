import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { groqTextModelCandidates, isGroqModelUnavailable } from "@/lib/groqVision";

// Post-draft AI analysis. Given both teams' picks and bans, a text model writes
// at most two short paragraphs — which draft is stronger and why (lane matchups,
// hero counters, composition/win condition) — ending with an explicit
// win-probability split. The client (admin live console) stores the result on
// games.draft_analysis and posts it once to the moment feed; both the admin and
// public match pages render it below the scoreboard. Analysis-only: this route
// never writes, it just returns the text.

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

type Side = { name: string; picks: string[]; bans: string[] };

function buildPrompt(a: Side, b: Side): string {
  const fmt = (s: Side) =>
    `${s.name}\n  Picks: ${s.picks.length ? s.picks.join(", ") : "—"}\n  Bans: ${s.bans.length ? s.bans.join(", ") : "—"}`;
  return `You are a professional Mobile Legends: Bang Bang draft analyst. Analyze this completed draft.

${fmt(a)}

${fmt(b)}

Write AT MOST TWO short paragraphs, plain text (no markdown, no headings):
1) Which side has the stronger draft and why — concrete lane matchups, hero counters, and each team's composition / win condition (e.g. early-game dive, late-game scaling, teamfight, pick-off).
2) End with one explicit line exactly like: "Draft edge: <TEAM NAME> ~NN%" where NN is that team's win probability from the draft alone (50–75 typical; use 50% only if truly even).

Be concise, specific, and neutral. Do not invent heroes that are not listed.`;
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Draft analysis isn't configured — set GROQ_API_KEY." }, { status: 503 });

  const body = await req.json().catch(() => null);
  const teamA: Side | undefined = body?.teamA;
  const teamB: Side | undefined = body?.teamB;
  if (!teamA?.name || !teamB?.name || !Array.isArray(teamA.picks) || !Array.isArray(teamB.picks)) {
    return NextResponse.json({ error: "Missing teamA/teamB picks" }, { status: 400 });
  }
  if (teamA.picks.length === 0 && teamB.picks.length === 0) {
    return NextResponse.json({ error: "No picks to analyze yet" }, { status: 400 });
  }

  const prompt = buildPrompt(teamA, teamB);
  const callModel = (model: string) =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 400, // two short paragraphs
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

  const candidates = groqTextModelCandidates();
  let data: { choices?: { message?: { content?: string } }[] } | null = null;
  let lastStatus = 502;
  let lastErr = "";
  for (const model of candidates) {
    let res: Response;
    try {
      res = await callModel(model);
    } catch (err) {
      return NextResponse.json({ error: `Groq request failed: ${(err as Error).message}` }, { status: 502 });
    }
    if (res.ok) {
      data = await res.json();
      break;
    }
    lastStatus = res.status;
    lastErr = await res.text();
    if (!isGroqModelUnavailable(res.status, lastErr)) break;
  }
  if (!data) {
    const message = isGroqModelUnavailable(lastStatus, lastErr)
      ? `No usable Groq text model — tried ${candidates.join(", ")}. Set GROQ_TEXT_MODEL to a model your account can access.`
      : `Groq API error (${lastStatus}): ${lastErr.slice(0, 200)}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const analysis = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!analysis) return NextResponse.json({ error: "The model returned no analysis, try again." }, { status: 502 });
  return NextResponse.json({ analysis });
}
