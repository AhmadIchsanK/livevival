import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { aiTextProviders, runTextCompletion } from "@/lib/groqVision";
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
  return `You write short, punchy Mobile Legends: Bang Bang caster one-liners for a live match ticker. Generate ${count} DISTINCT lines for the "${LABEL[condition]}" situation, each in BOTH English and Bahasa Indonesia.

Rules:
- Each line is ONE sentence, natural spoken-caster tone, energetic but not cringe.
- Use ONLY these placeholders, written EXACTLY as shown (curly braces included), and use the SAME placeholders in both languages. You may use fewer, but NEVER invent a placeholder not in this list:
${placeholderHelp}
- Do NOT use team names, player names, or hero names literally — use the placeholders so the line works for any match.
- The Bahasa Indonesia version must sound like a real Indonesian MLBB caster/streamer — casual Gen-Z gamer slang with esports soul, NOT a stiff textbook translation. Use natural gaming slang where it fits: "war" (teamfight), "cuan" (gold profit), "gacor" (on fire), "embat"/"nyomot"/"sikat" (grab a kill/objective), "keancem" (under threat), "auto" (instantly), "sadis"/"parah"/"gede banget" (huge), "nempel"/"tipis-tipis" (close), "apes"/"sial" (unlucky), "OP banget", "kabur" (running away with a lead), "adem" (quiet). Keep it hype but not cringe. Keep in-game terms in English inside the Indonesian line: Lord, Turtle, Tower, gold, net worth, K/D/A, MVP.
- Vary the phrasing, verbs, and rhythm strongly across the ${count} lines. No two should feel like the same sentence.
- Output EXACTLY one line per row in the format: English version ||| Indonesian version
- No markdown, no numbering, no quotes, nothing else.${existingBlock}`;
}

// One suggested line in both languages, parsed from an "EN ||| ID" row.
type Pair = { en: string; id: string };

// Extract clean EN/ID candidate pairs from a raw model completion.
function parsePairs(raw: string): Pair[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, "").trim())
    .filter((l) => l.includes("|||"))
    .map((l) => {
      const [en, id] = l.split("|||");
      return { en: (en ?? "").replace(/^["'“”]+|["'“”]+$/g, "").trim(), id: (id ?? "").replace(/^["'“”]+|["'“”]+$/g, "").trim() };
    })
    .filter((p) => p.en.length >= 6 && p.en.length <= 240);
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

  if (aiTextProviders().length === 0)
    return NextResponse.json({ error: "AI isn't configured — set AI_API_KEY (or GROQ_API_KEY) and AI_TEXT_MODEL." }, { status: 503 });

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

  const suggestions: { condition: CommentaryCondition; template: string; templateId: string; reads: string; readsId: string }[] = [];
  let lastError: { status: number; message: string } | null = null;

  for (const condition of targets) {
    const prompt = buildPrompt(condition, perCondition, existingByCondition.get(condition) ?? []);
    // Runs the whole provider chain (primary + numbered backups), falling
    // through on quota / model-unavailable / empty answer.
    const result = await runTextCompletion({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      maxTokens: 1400,
    });
    if (!result.ok) {
      lastError = { status: result.status, message: result.message };
      break; // whole chain spent — no point trying more conditions
    }

    const existingSet = new Set((existingByCondition.get(condition) ?? []).map((t) => t.toLowerCase()));
    const seen = new Set<string>();
    // Prefer the bilingual "EN ||| ID" rows; fall back to English-only rows
    // (no Indonesian) if the model ignored the format.
    const pairs = parsePairs(result.content);
    const rows: { en: string; id: string | null }[] =
      pairs.length > 0 ? pairs.map((p) => ({ en: p.en, id: p.id || null })) : parseLines(result.content).map((en) => ({ en, id: null }));
    for (const row of rows) {
      // Validate against the placeholders this condition supplies (English is
      // the source of truth; the ID line uses the same placeholders).
      const reads = renderTemplate(row.en, SAMPLE_FACTS[condition]);
      if (!reads) continue;
      const readsId = row.id ? renderTemplate(row.id, SAMPLE_FACTS[condition]) : null;
      const key = row.en.toLowerCase();
      if (existingSet.has(key) || seen.has(key)) continue;
      seen.add(key);
      // Only keep the ID line if it also renders cleanly; otherwise leave it
      // blank (the engine falls back to English).
      suggestions.push({ condition, template: row.en, templateId: readsId ? (row.id as string) : "", reads, readsId: readsId ?? "" });
    }
  }

  if (suggestions.length === 0) {
    if (lastError) return NextResponse.json({ error: lastError.message }, { status: lastError.status });
    return NextResponse.json({ error: "The model returned no usable lines — try again." }, { status: 502 });
  }

  return NextResponse.json({ suggestions });
}
