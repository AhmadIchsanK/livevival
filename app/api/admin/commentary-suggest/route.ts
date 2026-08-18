import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { aiBaseUrl, aiApiKey, groqTextModelCandidates, isGroqModelUnavailable, stripReasoning } from "@/lib/groqVision";
import {
  COMMENTARY_CONDITIONS,
  COMMENTARY_PLACEHOLDERS,
  renderTemplate,
  type CommentaryCondition,
} from "@/lib/matchCommentary";

// AI "auto-improve" for the auto-commentary template library. Given a condition
// (or all conditions), a text model writes fresh, varied caster one-liners that
// use ONLY the placeholders that condition supplies. Every suggestion is
// validated server-side against sample facts — any line referencing a
// placeholder the condition doesn't provide is dropped, so nothing that can't
// fire ever reaches the admin. This route only SUGGESTS; the admin reviews and
// the client writes the accepted lines to commentary_templates.

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

// Sample facts per condition — mirrors the editor's preview facts. Used to
// validate that a suggested line only uses placeholders the condition supplies.
const SAMPLE_FACTS: Record<CommentaryCondition, Record<string, string | number>> = {
  net_worth: { lead: "ONIC", trail: "FLCN", diff: "14.0k", closed: "6.0k" },
  kills: { lead: "ONIC", trail: "FLCN", hi: 10, lo: 4, count: 3, scorer: "ONIC" },
  tower: { team: "ONIC", count: 5, leader: "ONIC", hi: 7, lo: 2 },
  turtle: { team: "ONIC" },
  lord: { team: "ONIC" },
  player_kda: { player: "Kairi", hero: "Ling", k: 8, d: 0, a: 3, ka: 11 },
  win_prob: { favored: "ONIC", pct: 90, to: "ONIC" },
  hero: { player: "Kairi", hero: "Ling" },
  general: {},
};

const LABEL: Record<string, string> = Object.fromEntries(COMMENTARY_CONDITIONS.map((c) => [c.key, c.label]));

function buildPrompt(condition: CommentaryCondition, count: number, existing: string[]): string {
  const ph = COMMENTARY_PLACEHOLDERS[condition];
  const placeholderHelp = ph.length
    ? ph.map((p) => `${p.token} = ${p.desc}`).join("\n")
    : "(this condition has NO placeholders — write plain lines with no {curly} tokens)";
  const existingBlock = existing.length
    ? `\nAvoid duplicating or lightly rephrasing these lines that already exist:\n${existing.slice(0, 40).map((t) => `- ${t}`).join("\n")}`
    : "";
  return `You write short, punchy Mobile Legends: Bang Bang caster one-liners for a live match ticker. Generate ${count} DISTINCT lines for the "${LABEL[condition]}" situation.

Rules:
- Each line is ONE sentence, natural spoken-caster tone, energetic but not cringe.
- Use ONLY these placeholders, written EXACTLY as shown (curly braces included). You may use fewer, but NEVER invent a placeholder not in this list:
${placeholderHelp}
- Do NOT use team names, player names, or hero names literally — use the placeholders so the line works for any match.
- Vary the phrasing, verbs, and rhythm strongly across the ${count} lines. No two should feel like the same sentence.
- No markdown, no numbering, no quotes. Output ONE line per row, nothing else.${existingBlock}`;
}

// Extract clean candidate lines from a raw model completion.
function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, "").trim())
    .map((l) => l.replace(/^["'“”]+|["'“”]+$/g, "").trim())
    .filter((l) => l.length >= 6 && l.length <= 240);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const apiKey = aiApiKey();
  if (!apiKey) return NextResponse.json({ error: "AI isn't configured — set AI_API_KEY (or GROQ_API_KEY)." }, { status: 503 });

  const body = await req.json().catch(() => null);
  const requested: string = body?.condition ?? "all";
  const perCondition: number = Math.min(12, Math.max(3, Number(body?.count) || 8));
  const targets: CommentaryCondition[] =
    requested === "all"
      ? COMMENTARY_CONDITIONS.map((c) => c.key)
      : COMMENTARY_CONDITIONS.some((c) => c.key === requested)
      ? [requested as CommentaryCondition]
      : [];
  if (targets.length === 0) return NextResponse.json({ error: "Unknown condition" }, { status: 400 });

  // Pull existing lines so the model doesn't just re-emit what's already there.
  const { data: existingRows } = await supabase
    .from("commentary_templates")
    .select("condition, template")
    .in("condition", targets);
  const existingByCondition = new Map<string, string[]>();
  for (const r of (existingRows as { condition: string; template: string }[]) ?? []) {
    const list = existingByCondition.get(r.condition) ?? [];
    list.push(r.template);
    existingByCondition.set(r.condition, list);
  }

  const candidates = groqTextModelCandidates();
  const callModel = (model: string, prompt: string) =>
    fetch(`${aiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.9, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });

  const suggestions: { condition: CommentaryCondition; template: string; reads: string }[] = [];
  let lastStatus = 502;
  let lastErr = "";

  for (const condition of targets) {
    const prompt = buildPrompt(condition, perCondition, existingByCondition.get(condition) ?? []);
    let data: { choices?: { message?: { content?: string } }[] } | null = null;
    for (const model of candidates) {
      let res: Response;
      try {
        res = await callModel(model, prompt);
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
    if (!data) break; // fall through to the error handling below

    const text = stripReasoning(data.choices?.[0]?.message?.content || "");
    const existingSet = new Set((existingByCondition.get(condition) ?? []).map((t) => t.toLowerCase()));
    const seen = new Set<string>();
    for (const line of parseLines(text)) {
      // Validate: only keep lines whose placeholders the condition supplies.
      const reads = renderTemplate(line, SAMPLE_FACTS[condition]);
      if (!reads) continue;
      const key = line.toLowerCase();
      if (existingSet.has(key) || seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ condition, template: line, reads });
    }
  }

  if (suggestions.length === 0) {
    const message = isGroqModelUnavailable(lastStatus, lastErr)
      ? `No usable text model at ${aiBaseUrl()} — tried ${candidates.join(", ")}. Check AI_BASE_URL / AI_TEXT_MODEL on Production and redeploy.`
      : lastStatus === 429
      ? `AI rate/quota limit hit (429) at ${new URL(aiBaseUrl()).host}. Wait for the free-tier cap to reset or switch provider.`
      : lastErr
      ? `AI API error (${lastStatus}): ${lastErr.slice(0, 200)}`
      : "The model returned no usable lines — try again.";
    return NextResponse.json({ error: message }, { status: lastStatus === 429 ? 429 : 502 });
  }

  return NextResponse.json({ suggestions });
}
