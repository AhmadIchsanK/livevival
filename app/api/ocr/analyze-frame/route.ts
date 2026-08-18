import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { flags } from "@/lib/featureFlags";
import { observeVision } from "@/lib/reconstruction/visionObserver";
import type { VisionPlayerStat } from "@/lib/reconstruction/visionObserver";
import type { PlayerKda } from "@/lib/reconstruction/validators/kda";
import { asTeamId, asPlayerId } from "@/lib/reconstruction/types";
import { groqVisionModelCandidates, isGroqModelUnavailable } from "@/lib/groqVision";

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
    confidence?: number | null;
  }
): Promise<{ playerStatsApplied: number; netWorthApplied: boolean; skippedReason?: string; visionObservations?: number }> {
  const [{ data: match }, { data: gameRow }] = await Promise.all([
    supabase
      .from("matches")
      .select("state, team_a:teams!matches_team_a_id_fkey(id, name), team_b:teams!matches_team_b_id_fkey(id, name)")
      .eq("id", matchId)
      .single(),
    supabase.from("games").select("status, current_time_seconds").eq("id", gameId).single(),
  ]);
  if (!match) return { playerStatsApplied: 0, netWorthApplied: false, skippedReason: "Match not found" };
  if (match.state !== "GAME_STARTED") {
    return { playerStatsApplied: 0, netWorthApplied: false, skippedReason: `Match phase is ${match.state}, not GAME_STARTED — nothing applied` };
  }
  // Validation-spec golden rule: once a game is finished, reject any
  // further gameplay stat writes — mirrors the client pipeline's
  // game.status === "finished" guard (captureTickBody/captureFrameAndAnalyze
  // in the admin console) so this relay path can't straggle a write in
  // after Declare Winner if match.state hasn't been walked forward yet.
  if (gameRow?.status === "finished") {
    return { playerStatsApplied: 0, netWorthApplied: false, skippedReason: "This game is already finished — nothing applied" };
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

  // Validation spec §3 rules 5/7 and §4, mirroring the client OCR pipeline
  // (captureTickBody in app/admin/matches/[id]/live/page.tsx). This path
  // previously applied ONLY the monotonic never-decreases clamp — no
  // per-tick spike ceiling and no cross-player relationship check — which
  // matters more here than on the client, because this route commits
  // autonomously with no flagged-reading UI for an admin to catch a bad
  // value in. A vision model misreading one digit (2 kills as 22) wrote it
  // straight through, and the never-decreases clamp then made it permanent.
  // Unconfirmable readings are clamped to the last plausible value per §2
  // ("if OCR is missing, uncertain, or invalid → keep the last confirmed
  // value") rather than flagged, since there is nobody to ask here.
  const MAX_KILL_GAIN_PER_TICK = 10;
  const MAX_DEATH_GAIN_PER_TICK = 10;
  const MAX_ASSIST_GAIN_PER_TICK = 15;
  const clampStat = (read: number | null, stored: number | null | undefined, maxGain: number): number | null => {
    if (read == null) return stored ?? null;
    const floor = stored ?? 0;
    if (stored != null && read < stored) return stored; // never-decreases
    return read - floor > maxGain ? floor + maxGain : read;
  };

  // Resolved for every row first, so the deaths-vs-enemy-kills check below
  // validates the whole frame against itself rather than against a
  // half-updated snapshot (§4: "validate all affected players together").
  const candidates = (detection.player_stats ?? [])
    .map((row) => {
      const teamId = matchTeamId(teams, row.team_name);
      const playerId = matchPlayerId(playerPool, row.player_name, teamId);
      if (!playerId) return null;
      const existing = statsPool.find((s) => s.player_id === playerId);
      return {
        row,
        playerId,
        teamId: teamId ?? playerPool.find((p) => p.id === playerId)?.team_id ?? null,
        existing,
        kills: clampStat(row.kills, existing?.kills, MAX_KILL_GAIN_PER_TICK),
        deaths: clampStat(row.deaths, existing?.deaths, MAX_DEATH_GAIN_PER_TICK),
        assists: clampStat(row.assists, existing?.assists, MAX_ASSIST_GAIN_PER_TICK),
        gold: row.gold != null ? (existing?.gold != null ? Math.max(row.gold, existing.gold) : row.gold) : existing?.gold ?? null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // §4 "Player deaths cannot exceed enemy team kills" — an impossible
  // relationship, so the offending deaths value is rejected back to the
  // last value that was possible (§3 rule 7). Kills/assists on the same
  // read are independent and stay.
  const teamKillTotal = (teamId: string | null) => {
    if (!teamId) return 0;
    return playerPool
      .filter((p) => p.team_id === teamId)
      .reduce((sum, p) => {
        const c = candidates.find((c) => c.playerId === p.id);
        if (c) return sum + (c.kills ?? 0);
        return sum + (statsPool.find((s) => s.player_id === p.id)?.kills ?? 0);
      }, 0);
  };
  for (const c of candidates) {
    if (c.deaths == null || !c.teamId) continue;
    const enemyTeamId = teams.find((t) => t.id !== c.teamId)?.id ?? null;
    if (!enemyTeamId) continue;
    const enemyKills = teamKillTotal(enemyTeamId);
    if (c.deaths > enemyKills) {
      c.deaths = Math.min(c.deaths, Math.max(c.existing?.deaths ?? 0, enemyKills));
    }
  }

  let playerStatsApplied = 0;
  for (const c of candidates) {
    await supabase.from("player_stats").upsert(
      {
        game_id: gameId,
        match_id: matchId,
        player_id: c.playerId,
        hero_name: c.row.hero_name ?? null,
        hero_id: matchHeroId(heroPool, c.row.hero_name),
        kills: c.kills,
        deaths: c.deaths,
        assists: c.assists,
        gold: c.gold,
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
    const minuteMark = Math.floor((gameRow?.current_time_seconds ?? 0) / 60);
    await supabase.from("net_worth_snapshots").insert({
      game_id: gameId,
      match_id: matchId,
      minute_mark: minuteMark,
      team_a_gold: clamp(knownAGold, detection.net_worth?.team_a_gold ?? null),
      team_b_gold: clamp(knownBGold, detection.net_worth?.team_b_gold ?? null),
    });
    netWorthApplied = true;
  }

  // ── AI Vision as a non-authoritative observer (spec §25-27) ──────────────
  // When enabled, ALSO record this AI reading as append-only evidence in
  // game_observations, graded through the SAME reconstruction validators +
  // evidence model (spec §26/§30). This is deliberately separate from the
  // legacy writes above: it never changes what was committed to
  // player_stats/net_worth and never affects public reads — it only builds the
  // observation trail the hybrid-fusion phase reconciles against CV. Wrapped so
  // any failure here can never corrupt or block the detection response.
  let visionObservations = 0;
  if (flags.reconstructionAiObserver && teamA && teamB) {
    try {
      const confirmedKda = new Map<string, PlayerKda>();
      for (const s of statsPool) {
        if (s.player_id) confirmedKda.set(s.player_id, { kills: s.kills ?? 0, deaths: s.deaths ?? 0, assists: s.assists ?? 0 });
      }
      const teamOf = new Map<string, string>();
      for (const p of playerPool) if (p.team_id) teamOf.set(p.id, p.team_id);
      const confirmedNetWorth: Record<string, number | null> = {
        [teamA.id]: latestNetWorth?.team_a_gold ?? null,
        [teamB.id]: latestNetWorth?.team_b_gold ?? null,
      };

      // Only observe player rows with a fully-legible K/D/A — a partial row
      // can't be validated as a batch, and the spec forbids inventing missing
      // fields (§12). Reuses the same id resolution as the legacy path.
      const visionPlayers: VisionPlayerStat[] = [];
      for (const row of detection.player_stats ?? []) {
        if (row.kills == null || row.deaths == null || row.assists == null) continue;
        const teamId = matchTeamId(teams, row.team_name);
        const playerId = matchPlayerId(playerPool, row.player_name, teamId);
        if (!playerId || !teamId) continue;
        visionPlayers.push({ playerId: asPlayerId(playerId), teamId: asTeamId(teamId), kills: row.kills, deaths: row.deaths, assists: row.assists });
      }

      const visionNetWorth: Record<string, number> = {};
      if (detection.net_worth?.team_a_gold != null) visionNetWorth[teamA.id] = detection.net_worth.team_a_gold;
      if (detection.net_worth?.team_b_gold != null) visionNetWorth[teamB.id] = detection.net_worth.team_b_gold;

      const observations = observeVision(
        { players: visionPlayers, netWorth: visionNetWorth },
        { confirmedKda, confirmedNetWorth, teamOf, teamAId: asTeamId(teamA.id), teamBId: asTeamId(teamB.id) },
        { rawConfidence: detection.confidence ?? null }
      );

      if (observations.length > 0) {
        const now = new Date().toISOString();
        const gameTime = gameRow?.current_time_seconds ?? null;
        const rows = observations.map((o) => ({
          id: globalThis.crypto.randomUUID(),
          game_id: gameId,
          match_id: matchId,
          field: o.field,
          team_id: o.teamId ?? null,
          player_id: o.playerId ?? null,
          game_time_seconds: gameTime,
          captured_at: now,
          raw_value: o.rawValue,
          normalized_value: o.normalizedValue,
          confidence: detection.confidence ?? null,
          source: "vision",
          status: o.status,
        }));
        const { error } = await supabase.from("game_observations").insert(rows);
        if (!error) visionObservations = rows.length;
      }
    } catch {
      // Observer is best-effort evidence — never let it affect the response.
    }
  }

  return { playerStatsApplied, netWorthApplied, visionObservations };
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

  const callModel = (model: string) =>
    fetch("https://api.groq.com/openai/v1/chat/completions", {
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

  // Try each candidate vision model, falling through only when Groq says the
  // current id is unavailable for this account (deprecated / no access / 404).
  const candidates = groqVisionModelCandidates();
  let groqRes: Response | null = null;
  let lastErr = "";
  let lastStatus = 502;
  for (const model of candidates) {
    let res: Response;
    try {
      res = await callModel(model);
    } catch (err) {
      return NextResponse.json({ error: `Groq request failed: ${(err as Error).message}` }, { status: 502 });
    }
    if (res.ok) {
      groqRes = res;
      break;
    }
    lastErr = await res.text();
    lastStatus = res.status;
    if (!isGroqModelUnavailable(res.status, lastErr)) break; // real error → stop
  }
  if (!groqRes) {
    const message = isGroqModelUnavailable(lastStatus, lastErr)
      ? `No usable Groq vision model — tried ${candidates.join(", ")}. Set GROQ_VISION_MODEL to a model your account can access.`
      : `Groq API error (${lastStatus}): ${lastErr}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const groqData = await groqRes.json();
  const choice = groqData.choices?.[0];
  // `??` only substitutes for null/undefined — a genuinely empty string
  // (`content: ""`, which Groq can return when the model spends its whole
  // token budget "thinking" and never writes a visible answer) sailed
  // straight through the old `?? "{}"` fallback unreplaced, then failed
  // extraction with an unhelpfully blank "()" in the error message. `||`
  // catches the empty-string case too since "" is falsy.
  const raw: string = choice?.message?.content || "{}";
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const extracted = extractFirstJsonObject(withoutThinking);
  if (!extracted) {
    const finishReason = choice?.finish_reason;
    const reasonHint =
      finishReason === "length"
        ? " — the model hit its token limit before writing a full response, try again"
        : !withoutThinking
        ? " — the model returned no visible content this time, try again"
        : "";
    return NextResponse.json(
      { error: `No complete JSON object in model response${reasonHint} (${withoutThinking.slice(0, 120)})` },
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
