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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any; // no generated Database types wired up for this route; see createClient() call below

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Same fuzzy substring matching the admin console's client-side
// matchTeamId/matchPlayerId/matchHeroId use (app/admin/matches/[id]/
// live/page.tsx) — kept in lockstep with those on purpose, not
// reimplemented independently, since this route exists to be a drop-in
// alternative write path for the exact same detections, not a divergent
// one.
function matchTeamId(teams: { id: string; name: string }[], teamName?: string | null): string | null {
  if (!teamName) return null;
  const n = normalize(teamName);
  return teams.find((t) => normalize(t.name).includes(n) || n.includes(normalize(t.name)))?.id ?? null;
}
function matchHeroId(heroes: { id: string; name: string }[], heroName?: string | null): string | null {
  if (!heroName) return null;
  const n = normalize(heroName);
  return (heroes.find((h) => normalize(h.name) === n) ?? heroes.find((h) => normalize(h.name).includes(n) || n.includes(normalize(h.name))))?.id ?? null;
}
function matchPlayerId(players: { id: string; ign: string; team_id: string | null }[], playerName?: string | null, teamId?: string | null): string | null {
  if (!playerName) return null;
  const n = normalize(playerName);
  const pool = teamId ? players.filter((p) => p.team_id === teamId) : players;
  return (pool.find((p) => normalize(p.ign) === n) ?? pool.find((p) => normalize(p.ign).includes(n) || n.includes(normalize(p.ign))))?.id ?? null;
}

// The "relay" write path — same never-decreases-guarded writes
// app/admin/matches/[id]/live/page.tsx's applyAiDetection performs
// client-side, just run here instead so a browser tab only has to
// capture a frame and forward it: the vision call AND the DB commit both
// land within this one request, instead of depending on the tab staying
// open and connected long enough to receive the response and apply it
// itself. Only ever touches player_stats/net_worth (the two writes
// worth protecting against a dropped connection) — the game timer and
// key-moment/winner suggestions stay client-side, since those either
// need a live UI to confirm against or are cheap enough to just retry
// next tick.
async function applyDetectionServerSide(
  supabase: SupabaseLike,
  matchId: string,
  gameId: string,
  detection: {
    player_stats?: { player_name: string; team_name: string; hero_name: string | null; kills: number | null; deaths: number | null; assists: number | null; gold: number | null }[];
    net_worth?: { team_a_gold: number | null; team_b_gold: number | null };
  }
): Promise<{ playerStatsApplied: number; netWorthApplied: boolean; skippedReason?: string }> {
  const { data: match } = await supabase
    .from("matches")
    .select("state, team_a:teams!matches_team_a_id_fkey(id, name), team_b:teams!matches_team_b_id_fkey(id, name)")
    .eq("id", matchId)
    .single();
  if (!match) return { playerStatsApplied: 0, netWorthApplied: false, skippedReason: "Match not found" };
  if (match.state !== "GAME_STARTED") {
    return { playerStatsApplied: 0, netWorthApplied: false, skippedReason: `Match phase is ${match.state}, not GAME_STARTED — nothing applied` };
  }
  const teamA = match.team_a as unknown as { id: string; name: string } | null;
  const teamB = match.team_b as unknown as { id: string; name: string } | null;
  const teams = [teamA, teamB].filter((t): t is { id: string; name: string } => !!t);

  const [{ data: players }, { data: heroes }, { data: existingStats }, { data: latestNetWorthRows }] = await Promise.all([
    supabase.from("players").select("id, ign, team_id").in("team_id", teams.map((t) => t.id)),
    supabase.from("heroes").select("id, name"),
    supabase.from("player_stats").select("player_id, hero_name, kills, deaths, assists, gold").eq("game_id", gameId),
    supabase.from("net_worth_snapshots").select("team_a_gold, team_b_gold").eq("game_id", gameId).order("minute_mark", { ascending: false }).limit(1),
  ]);
  const playerPool = (players ?? []) as { id: string; ign: string; team_id: string | null }[];
  const heroPool = (heroes ?? []) as { id: string; name: string }[];
  const statsPool = (existingStats ?? []) as { player_id: string | null; hero_name: string | null; kills: number | null; deaths: number | null; assists: number | null; gold: number | null }[];
  const latestNetWorth = (latestNetWorthRows ?? [])[0] as { team_a_gold: number; team_b_gold: number } | undefined;

  let playerStatsApplied = 0;
  for (const row of detection.player_stats ?? []) {
    const teamId = matchTeamId(teams, row.team_name);
    const playerId = matchPlayerId(playerPool, row.player_name, teamId);
    if (!playerId) continue;
    const existing = statsPool.find((s) => s.player_id === playerId);
    const kills = row.kills != null ? (existing?.kills != null ? Math.max(row.kills, existing.kills) : row.kills) : existing?.kills ?? null;
    const deaths = row.deaths != null ? (existing?.deaths != null ? Math.max(row.deaths, existing.deaths) : row.deaths) : existing?.deaths ?? null;
    const assists = row.assists != null ? (existing?.assists != null ? Math.max(row.assists, existing.assists) : row.assists) : existing?.assists ?? null;
    const gold = row.gold != null ? (existing?.gold != null ? Math.max(row.gold, existing.gold) : row.gold) : existing?.gold ?? null;
    await supabase.from("player_stats").upsert(
      {
        game_id: gameId,
        match_id: matchId,
        player_id: playerId,
        hero_name: row.hero_name ?? null,
        hero_id: matchHeroId(heroPool, row.hero_name),
        kills,
        deaths,
        assists,
        gold,
      },
      { onConflict: "game_id,player_id" }
    );
    playerStatsApplied++;
  }

  let netWorthApplied = false;
  if (detection.net_worth?.team_a_gold != null || detection.net_worth?.team_b_gold != null) {
    const MAX_NET_WORTH_GAIN_PER_TICK = 8000;
    const knownAGold = latestNetWorth?.team_a_gold ?? null;
    const knownBGold = latestNetWorth?.team_b_gold ?? null;
    const clamp = (known: number | null, read: number | null) => {
      if (read == null) return known ?? null;
      const floored = known != null && read < known ? known : read;
      return known != null && floored - known > MAX_NET_WORTH_GAIN_PER_TICK ? known + MAX_NET_WORTH_GAIN_PER_TICK : floored;
    };
    const { data: game } = await supabase.from("games").select("current_time_seconds").eq("id", gameId).single();
    const minuteMark = Math.floor((game?.current_time_seconds ?? 0) / 60);
    await supabase.from("net_worth_snapshots").insert({
      game_id: gameId,
      match_id: matchId,
      minute_mark: minuteMark,
      team_a_gold: clamp(knownAGold, detection.net_worth?.team_a_gold ?? null),
      team_b_gold: clamp(knownBGold, detection.net_worth?.team_b_gold ?? null),
    });
    netWorthApplied = true;
  }

  return { playerStatsApplied, netWorthApplied };
}

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
  // Optional — pass both to have this request also commit the write
  // (player_stats/net_worth) before responding, instead of just returning
  // the raw detection for the caller to apply itself. Omit either to keep
  // the original analyze-only behavior.
  const matchId: string | undefined = body?.matchId;
  const gameId: string | undefined = body?.gameId;
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
        // Reserved output budget also counts against the account's tokens-
        // per-minute limit alongside the (now downscaled) input image — a
        // single 10-player scoreboard + full draft board response still
        // fits comfortably under 2000.
        max_tokens: 2000,
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return NextResponse.json({ error: "Model response wasn't valid JSON" }, { status: 502 });
  }

  if (matchId && gameId) {
    try {
      const applied = await applyDetectionServerSide(supabase, matchId, gameId, parsed);
      return NextResponse.json({ ...parsed, applied });
    } catch (err) {
      // The vision read itself succeeded — still return it so the caller
      // isn't left with nothing, just flagged as unwritten rather than
      // failing the whole request over a write-side error.
      return NextResponse.json({ ...parsed, applied: { playerStatsApplied: 0, netWorthApplied: false, skippedReason: (err as Error).message } });
    }
  }

  return NextResponse.json(parsed);
}
