import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { aiTextProviders, runTextCompletion } from "@/lib/groqVision";

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

function buildPrompt(a: Side, b: Side, lang: "en" | "id"): string {
  const fmt = (s: Side) =>
    `${s.name}\n  Picks: ${s.picks.length ? s.picks.join(", ") : "—"}\n  Bans: ${s.bans.length ? s.bans.join(", ") : "—"}`;
  if (lang === "id") {
    // Bahasa Indonesia, semi-formal Gen-Z. In-game terms (Lord, Turtle, draft,
    // teamfight, pick-off, hero names) stay English; the edge line format is
    // kept identical so the client can parse it the same way.
    return `Kamu analis draft Mobile Legends: Bang Bang profesional. Analisis draft yang udah selesai ini dalam Bahasa Indonesia yang santai tapi tetap rapi (gaya Gen-Z, jangan kaku).

${fmt(a)}

${fmt(b)}

Tulis MAKSIMAL DUA paragraf pendek, teks biasa (tanpa markdown, tanpa heading):
1) Tim mana yang draft-nya lebih kuat dan kenapa — matchup lane yang konkret, counter hero, dan komposisi / win condition tiap tim (misal early-game dive, late-game scaling, teamfight, pick-off).
2) Akhiri dengan satu baris persis seperti ini: "Draft edge: <NAMA TIM> ~NN%" di mana NN itu peluang menang tim itu murni dari draft (biasanya 50–75; pakai 50% cuma kalau bener-bener imbang).

Ringkas, spesifik, netral. Jangan ngarang hero yang nggak ada di daftar. Istilah dalam game (Lord, Turtle, teamfight, pick-off, nama hero) tetap pakai Bahasa Inggris.`;
  }
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

  if (aiTextProviders().length === 0)
    return NextResponse.json({ error: "Draft analysis isn't configured — set AI_API_KEY (or GROQ_API_KEY) and AI_TEXT_MODEL." }, { status: 503 });

  const body = await req.json().catch(() => null);
  const teamA: Side | undefined = body?.teamA;
  const teamB: Side | undefined = body?.teamB;
  if (!teamA?.name || !teamB?.name || !Array.isArray(teamA.picks) || !Array.isArray(teamB.picks)) {
    return NextResponse.json({ error: "Missing teamA/teamB picks" }, { status: 400 });
  }
  if (teamA.picks.length === 0 && teamB.picks.length === 0) {
    return NextResponse.json({ error: "No picks to analyze yet" }, { status: 400 });
  }

  const lang = body?.lang === "id" ? "id" : "en";
  const prompt = buildPrompt(teamA, teamB, lang);
  // Runs the whole provider chain (primary + numbered backups, each with its own
  // model list), falling through on quota / model-unavailable / empty answer.
  // max_tokens is roomy because a REASONING model (e.g. gemini-2.5-flash) spends
  // a variable budget "thinking" FIRST; too tight and the visible content comes
  // back empty or truncated ("…Yu Zhong's sustain and"). The runner strips any
  // <think> block and treats an empty answer as a reason to try the next model.
  const result = await runTextCompletion({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    maxTokens: 3000,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
  const analysis = result.content;
  return NextResponse.json({ analysis });
}
