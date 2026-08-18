import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { aiBaseUrl, aiApiKey, groqTextModelCandidates, isGroqModelUnavailable, stripReasoning } from "@/lib/groqVision";

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

  const apiKey = aiApiKey();
  if (!apiKey) return NextResponse.json({ error: "Draft analysis isn't configured — set AI_API_KEY (or GROQ_API_KEY)." }, { status: 503 });

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
    fetch(`${aiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        // Two short paragraphs is ~250 tokens, but a REASONING model (e.g.
        // gemini-2.5-flash) spends a large, variable budget "thinking" FIRST and
        // then writes the answer from what's left — too tight a cap and the
        // visible content either comes back empty ("returned no analysis") or is
        // truncated mid-sentence ("…Yu Zhong's sustain and"). A roomy budget
        // covers the hidden reasoning AND the full two paragraphs; any inline
        // <think> block is stripped below and the prompt still caps the prose.
        max_tokens: 3000,
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
      return NextResponse.json({ error: `AI request failed: ${(err as Error).message}` }, { status: 502 });
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
      ? `No usable text model at ${aiBaseUrl()} — tried ${candidates.join(", ")}. If that endpoint is api.groq.com, AI_BASE_URL didn't take effect (check it's set on Production and redeploy). Otherwise set AI_TEXT_MODEL to a model that endpoint serves.`
      : lastStatus === 429
      ? `AI rate/quota limit hit (429) at ${new URL(aiBaseUrl()).host}. The free tier's daily cap is used up — wait for it to reset, or switch AI_BASE_URL/AI_TEXT_MODEL to a provider with more headroom (e.g. OpenRouter free models).`
      : `AI API error (${lastStatus}): ${lastErr.slice(0, 200)}`;
    return NextResponse.json({ error: message }, { status: lastStatus === 429 ? 429 : 502 });
  }

  const choice = data.choices?.[0];
  // `|| ""` (not `??`) so a genuinely empty string from a reasoning model that
  // spent its whole budget thinking is caught too; strip any inline <think>.
  const analysis = stripReasoning(choice?.message?.content || "");
  if (!analysis) {
    const finishReason = (choice as { finish_reason?: string })?.finish_reason;
    const hint = finishReason === "length" ? " — it hit the token limit before writing; try again" : " — try again";
    return NextResponse.json({ error: `The model returned no analysis${hint}.` }, { status: 502 });
  }
  return NextResponse.json({ analysis });
}
