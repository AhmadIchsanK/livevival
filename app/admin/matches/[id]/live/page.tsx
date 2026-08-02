"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { createWorker } from "tesseract.js";

const OCR_KEYWORDS: { pattern: RegExp; type: string }[] = [
  { pattern: /SAVAGE/i, type: "savage" },
  { pattern: /MANIAC/i, type: "maniac" },
  { pattern: /LORD\s*STEAL/i, type: "lord_steal" },
  { pattern: /TURTLE\s*STEAL/i, type: "turtle_steal" },
  { pattern: /\bACE\b/i, type: "ace" },
];

type Match = {
  id: string;
  youtube_url: string | null;
  format: string | null;
  current_game_number: number;
  state: string;
  update_source: "liquipedia" | "local_ocr";
  series_winner_team_id: string | null;
  tournament: { name: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type Player = { id: string; team_id: string; ign: string; role: string | null };
type Game = { id: string; game_number: number; status: string; map: string | null; winner_team_id: string | null };
type FinishedGame = { id: string; game_number: number; status: string; map: string | null; winner_team_id: string | null; duration_seconds: number | null };
type PickBan = { id: string; team_id: string; player_id: string | null; hero_name: string; type: "pick" | "ban"; pick_order: number | null };
type PlayerStat = { id: string; player_id: string; hero_name: string | null; kills: number; deaths: number; assists: number; gold: number };
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null };
type KeyMoment = { id: string; type: string; player_id: string | null; minute_mark: number | null };

// Same fixed left-to-right draft order used across the admin (Players page
// role dropdown): exp lane, jungler, mid laner, gold laner, roamer.
const ROLE_ORDER = ["Exp Laner", "Jungler", "Mid Laner", "Gold Laner", "Roamer"];
const MAPS = ["Expanding Rivers", "Flying Cloud", "Dangerous Grass"];
function roleIndex(role: string | null) {
  const i = ROLE_ORDER.indexOf(role ?? "");
  return i === -1 ? ROLE_ORDER.length : i;
}

function youtubeEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return idMatch ? `https://www.youtube.com/embed/${idMatch[1]}` : null;
}

export default function LiveConsolePage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [pastGames, setPastGames] = useState<FinishedGame[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [pickBans, setPickBans] = useState<PickBan[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  const [minute, setMinute] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select(
        `id, youtube_url, format, current_game_number, state, update_source, series_winner_team_id,
         tournament:tournaments(name),
         team_a:teams!matches_team_a_id_fkey(id, name),
         team_b:teams!matches_team_b_id_fkey(id, name)`
      )
      .eq("id", matchId)
      .single();

    if (matchErr || !matchData) {
      setError(matchErr?.message ?? "Match not found");
      return;
    }
    const m = matchData as unknown as Match;
    setMatch(m);

    let { data: gameRow } = await supabase
      .from("games")
      .select("id, game_number, status, map, winner_team_id")
      .eq("match_id", matchId)
      .eq("game_number", m.current_game_number)
      .maybeSingle();

    if (!gameRow) {
      const { data: created, error: createErr } = await supabase
        .from("games")
        .insert({ match_id: matchId, game_number: m.current_game_number, status: "live" })
        .select("id, game_number, status, map, winner_team_id")
        .single();
      if (createErr) {
        setError(createErr.message);
        return;
      }
      gameRow = created;
    }
    setGame(gameRow as Game);

    const { data: past } = await supabase
      .from("games")
      .select("id, game_number, status, map, winner_team_id, duration_seconds")
      .eq("match_id", matchId)
      .neq("id", (gameRow as Game).id)
      .order("game_number");
    setPastGames((past as FinishedGame[]) ?? []);

    const teamIds = [m.team_a?.id, m.team_b?.id].filter(Boolean) as string[];
    const { data: playerRows } = await supabase
      .from("players")
      .select("id, team_id, ign, role")
      .in("team_id", teamIds);
    setPlayers((playerRows as Player[]) ?? []);

    if (gameRow) {
      const gid = (gameRow as Game).id;
      const [{ data: pb }, { data: ps }, { data: obj }, { data: km }] = await Promise.all([
        supabase.from("hero_picks_bans").select("id, team_id, player_id, hero_name, type, pick_order").eq("game_id", gid).order("pick_order"),
        supabase.from("player_stats").select("id, player_id, hero_name, kills, deaths, assists, gold").eq("game_id", gid),
        supabase.from("objectives").select("id, team_id, type, minute_mark").eq("game_id", gid).order("minute_mark"),
        supabase.from("key_moments").select("id, type, player_id, minute_mark").eq("game_id", gid).order("minute_mark"),
      ]);
      setPickBans((pb as PickBan[]) ?? []);
      setStats((ps as PlayerStat[]) ?? []);
      setObjectives((obj as Objective[]) ?? []);
      setKeyMoments((km as KeyMoment[]) ?? []);
    }
  }, [matchId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    autoStartedGameId.current = null;
  }, [game?.id]);

  // ── Telegram (admin-triggered) ───────────────────────────────────────
  // For matches on Liquipedia auto-sync, the worker posts match-live/
  // game-result/match-finished automatically. This is for what it can't:
  // draft recaps and key moments (Liquipedia has no live picks/bans feed
  // for an in-progress series — only once the whole match is marked
  // finished), and anything on a local_ocr match, which the worker skips
  // entirely since the admin's local capture session owns it.
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  async function postToTelegram(message: string, meta?: { entityType: string; entityId: string; notificationType: string }) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setTelegramStatus("Not signed in.");
      return;
    }
    const res = await fetch("/api/telegram/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, ...meta }),
    });
    const data = await res.json();
    setTelegramStatus(res.ok ? "Posted to Telegram." : data.error ?? "Failed to post.");
    setTimeout(() => setTelegramStatus(null), 4000);
  }

  // ── Quick add player ────────────────────────────────────────────────
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerTeam, setNewPlayerTeam] = useState("");
  async function addPlayer() {
    if (!newPlayerName || !newPlayerTeam) return;
    await supabase.from("players").insert({ ign: newPlayerName, team_id: newPlayerTeam });
    setNewPlayerName("");
    loadAll();
  }

  // ── Hero picks/bans ─────────────────────────────────────────────────
  // player_id is required for picks (so the console can show who's
  // actually playing this game, not the whole roster) and left null for
  // bans, which are team-level decisions rather than one player's.
  const [pbTeam, setPbTeam] = useState("");
  const [pbType, setPbType] = useState<"pick" | "ban">("ban");
  const [pbPlayer, setPbPlayer] = useState("");
  const [pbHero, setPbHero] = useState("");
  async function logPickBan() {
    if (!pbTeam || !pbHero || !game) return;
    if (pbType === "pick" && !pbPlayer) return;
    const { error } = await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      team_id: pbTeam,
      player_id: pbType === "pick" ? pbPlayer : null,
      hero_name: pbHero,
      type: pbType,
      pick_order: pickBans.length + 1,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setPbHero("");
    setPbPlayer("");
    loadAll();
  }
  async function deletePickBan(id: string) {
    const { error } = await supabase.from("hero_picks_bans").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }

  // ── Scoreboard ──────────────────────────────────────────────────────
  async function ensureStatRow(playerId: string) {
    const existing = stats.find((s) => s.player_id === playerId);
    if (existing || !game) return existing;
    const { data } = await supabase
      .from("player_stats")
      .insert({ game_id: game.id, player_id: playerId })
      .select("id, player_id, hero_name, kills, deaths, assists, gold")
      .single();
    if (data) setStats((prev) => [...prev, data as PlayerStat]);
    return data as PlayerStat | undefined;
  }
  async function updateStat(playerId: string, field: keyof PlayerStat, value: number | string) {
    let row = stats.find((s) => s.player_id === playerId);
    if (!row) row = await ensureStatRow(playerId);
    if (!row) return;
    await supabase.from("player_stats").update({ [field]: value }).eq("id", row.id);
    loadAll();
  }

  // ── Objectives ──────────────────────────────────────────────────────
  async function logObjective(teamId: string, type: string) {
    if (!game) return;
    await supabase.from("objectives").insert({ game_id: game.id, team_id: teamId, type, minute_mark: minute });
    loadAll();
  }
  async function deleteObjective(id: string) {
    const { error } = await supabase.from("objectives").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }

  // ── Key moments ─────────────────────────────────────────────────────
  const [kmType, setKmType] = useState("savage");
  const [kmPlayer, setKmPlayer] = useState("");
  async function logKeyMoment() {
    if (!game) return;
    await supabase.from("key_moments").insert({
      game_id: game.id,
      type: kmType,
      player_id: kmPlayer || null,
      minute_mark: minute,
    });
    loadAll();
  }
  async function deleteKeyMoment(id: string) {
    const { error } = await supabase.from("key_moments").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }

  // ── Item builds ─────────────────────────────────────────────────────
  async function saveItems(playerId: string, items: string[]) {
    if (!game) return;
    await supabase.from("item_snapshots").insert({
      game_id: game.id,
      player_id: playerId,
      minute_mark: minute,
      item_slots: items,
    });
  }

  // ── Net worth snapshot ──────────────────────────────────────────────
  async function logNetWorthSnapshot() {
    if (!game || !match || !match.team_a || !match.team_b) return;
    const teamAGold = stats
      .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_a?.id)
      .reduce((sum, s) => sum + (s.gold ?? 0), 0);
    const teamBGold = stats
      .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_b?.id)
      .reduce((sum, s) => sum + (s.gold ?? 0), 0);

    await supabase.from("net_worth_snapshots").insert({
      game_id: game.id,
      minute_mark: minute,
      team_a_gold: teamAGold,
      team_b_gold: teamBGold,
    });
  }

  // ── Local capture (admin PC) ─────────────────────────────────────────
  // Only meaningful when match.update_source === "local_ocr": deterministic,
  // local, free OCR on a screen-shared tab — no AI, no rate limits, no
  // datacenter-IP bot detection, because it's the admin's own browser
  // watching whatever is already playing. Reads text/numbers only (timer,
  // gold, kill-banner keywords) — hero icons and small scoreboard rows
  // aren't reliable to OCR, so picks/bans and per-player K/D/A stay as the
  // one-click pickers/inputs elsewhere on this page.
  type CaptureField = "timer" | "gold" | "kill_banner";
  const CAPTURE_FIELDS: { field: CaptureField; label: string }[] = [
    { field: "timer", label: "Match timer" },
    { field: "gold", label: "Team gold (A then B)" },
    { field: "kill_banner", label: "Kill banner" },
  ];
  type RegionBox = { xPct: number; yPct: number; wPct: number; hPct: number };

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Guards the auto GAME_STARTED transition below so it only fires once
  // per game, not on every OCR tick that finds a readable timer.
  const autoStartedGameId = useRef<string | null>(null);

  const [captureActive, setCaptureActive] = useState(false);
  const [calibratingField, setCalibratingField] = useState<CaptureField | null>(null);
  const [regions, setRegions] = useState<Record<CaptureField, RegionBox | null>>({
    timer: null,
    gold: null,
    kill_banner: null,
  });
  const [readings, setReadings] = useState<Record<CaptureField, string>>({ timer: "", gold: "", kill_banner: "" });
  const [suggestion, setSuggestion] = useState<{ type: string; raw: string } | null>(null);

  // ── Full-frame AI capture (no calibration) ───────────────────────────
  // Alternative to the manual crop-region OCR above: sends the whole
  // captured frame to /api/ocr/analyze-frame (Groq vision) every tick and
  // applies whatever it finds directly, instead of the admin dragging
  // pixel boxes around each element. Default mode — the manual regions
  // above stay available as a free, deterministic fallback if AI analysis
  // isn't configured (GROQ_API_KEY unset) or a tournament's overlay trips
  // it up.
  type AiDetection = {
    phase: string;
    game_timer_mm_ss: string | null;
    winning_team_name: string | null;
    key_moment_banner: string;
    key_moment_player_name: string | null;
    draft_actions: { type: "pick" | "ban"; team_name: string; hero_name: string }[];
    player_stats: { player_name: string; team_name: string; hero_name: string | null; kills: number | null; deaths: number | null; assists: number | null; gold: number | null }[];
    net_worth: { team_a_gold: number | null; team_b_gold: number | null };
    confidence: number;
  };
  const [captureMode, setCaptureMode] = useState<"ai" | "manual">("ai");
  const [heroes, setHeroes] = useState<{ id: string; name: string }[]>([]);
  const [overlayHint, setOverlayHint] = useState("");
  const [aiDetection, setAiDetection] = useState<AiDetection | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [suggestedWinner, setSuggestedWinner] = useState<string | null>(null);
  const lastAutoKeyMoment = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("heroes").select("id, name");
      setHeroes((data as { id: string; name: string }[]) ?? []);
    })();
  }, []);

  function normalize(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function matchTeamId(teamName?: string | null): string | null {
    if (!teamName || !match) return null;
    const n = normalize(teamName);
    if (match.team_a && (normalize(match.team_a.name).includes(n) || n.includes(normalize(match.team_a.name)))) return match.team_a.id;
    if (match.team_b && (normalize(match.team_b.name).includes(n) || n.includes(normalize(match.team_b.name)))) return match.team_b.id;
    return null;
  }
  function matchHeroId(heroName?: string | null): string | null {
    if (!heroName) return null;
    const n = normalize(heroName);
    return (heroes.find((h) => normalize(h.name) === n) ?? heroes.find((h) => normalize(h.name).includes(n) || n.includes(normalize(h.name))))?.id ?? null;
  }
  function matchPlayerId(playerName?: string | null, teamId?: string | null): string | null {
    if (!playerName) return null;
    const n = normalize(playerName);
    const pool = teamId ? players.filter((p) => p.team_id === teamId) : players;
    return (pool.find((p) => normalize(p.ign) === n) ?? pool.find((p) => normalize(p.ign).includes(n) || n.includes(normalize(p.ign))))?.id ?? null;
  }

  async function applyAiDetection(detection: AiDetection) {
    if (!game || !match) return;

    const timerMatch = detection.game_timer_mm_ss?.match(/(\d{1,2}):(\d{2})/);
    if (timerMatch) setMinute(Number(timerMatch[1]));
    if (detection.phase === "IN_GAME") maybeAutoStartGame();

    for (const action of detection.draft_actions ?? []) {
      const teamId = matchTeamId(action.team_name);
      if (!teamId || !action.hero_name) continue;
      const alreadyLogged = pickBans.some(
        (pb) => pb.team_id === teamId && pb.hero_name.toLowerCase() === action.hero_name.toLowerCase() && pb.type === action.type
      );
      if (alreadyLogged) continue;
      await supabase.from("hero_picks_bans").upsert(
        {
          game_id: game.id,
          match_id: matchId,
          team_id: teamId,
          hero_name: action.hero_name,
          hero_id: matchHeroId(action.hero_name),
          type: action.type,
          pick_order: pickBans.length + 1,
        },
        { onConflict: "game_id,team_id,hero_name,type" }
      );
    }

    for (const row of detection.player_stats ?? []) {
      const teamId = matchTeamId(row.team_name);
      const playerId = matchPlayerId(row.player_name, teamId);
      if (!playerId) continue;
      await supabase.from("player_stats").upsert(
        {
          game_id: game.id,
          match_id: matchId,
          player_id: playerId,
          hero_name: row.hero_name ?? null,
          hero_id: matchHeroId(row.hero_name),
          kills: row.kills ?? null,
          deaths: row.deaths ?? null,
          assists: row.assists ?? null,
          gold: row.gold ?? null,
        },
        { onConflict: "game_id,player_id" }
      );
    }

    if (detection.net_worth?.team_a_gold != null || detection.net_worth?.team_b_gold != null) {
      await supabase.from("net_worth_snapshots").insert({
        game_id: game.id,
        match_id: matchId,
        minute_mark: minute,
        team_a_gold: detection.net_worth?.team_a_gold ?? null,
        team_b_gold: detection.net_worth?.team_b_gold ?? null,
      });
    }

    // Dedup within a cooldown — a banner lingers on screen for several
    // seconds, so without this the same moment gets logged on every tick.
    if (detection.key_moment_banner && detection.key_moment_banner !== "NONE") {
      const playerId = matchPlayerId(detection.key_moment_player_name);
      const key = `${detection.key_moment_banner}:${playerId ?? ""}`;
      const now = Date.now();
      if (lastAutoKeyMoment.current.key !== key || now - lastAutoKeyMoment.current.at > 60000) {
        lastAutoKeyMoment.current = { key, at: now };
        await supabase.from("key_moments").insert({
          game_id: game.id,
          match_id: matchId,
          type: detection.key_moment_banner.toLowerCase(),
          player_id: playerId,
          minute_mark: minute,
          source: "ai",
          confidence: detection.confidence ?? null,
        });
      }
    }

    // Surfaced, not auto-applied — declareGameWinner() closes out the
    // series and already requires a confirm() click; too consequential to
    // fire from an unattended tick.
    if ((detection.phase === "VICTORY_DEFEAT_SCREEN" || detection.phase === "POST_GAME_STATS") && detection.winning_team_name) {
      const teamId = matchTeamId(detection.winning_team_name);
      if (teamId) setSuggestedWinner(teamId);
    }

    loadAll();
  }

  async function captureFrameAndAnalyze() {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.7);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setAiStatus("Not signed in.");
      return;
    }

    try {
      const res = await fetch("/api/ocr/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageBase64, overlayHint: overlayHint || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiStatus(data.error ?? "Analysis failed.");
        return;
      }
      setAiDetection(data as AiDetection);
      setAiStatus(null);
      await applyAiDetection(data as AiDetection);
    } catch (err) {
      setAiStatus((err as Error).message);
    }
  }

  useEffect(() => {
    if (!matchId) return;
    (async () => {
      const { data } = await supabase
        .from("capture_regions")
        .select("field, x_pct, y_pct, w_pct, h_pct")
        .eq("match_id", matchId);
      if (!data) return;
      setRegions((prev) => {
        const next = { ...prev };
        for (const r of data) {
          next[r.field as CaptureField] = { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct };
        }
        return next;
      });
    })();
  }, [matchId]);

  async function saveRegion(field: CaptureField, box: RegionBox) {
    setRegions((prev) => ({ ...prev, [field]: box }));
    await supabase.from("capture_regions").upsert(
      { match_id: matchId, field, x_pct: box.xPct, y_pct: box.yPct, w_pct: box.wPct, h_pct: box.hPct },
      { onConflict: "match_id,field" }
    );
  }

  function cropCanvasFor(video: HTMLVideoElement, box: RegionBox) {
    const cx = (box.xPct / 100) * video.videoWidth;
    const cy = (box.yPct / 100) * video.videoHeight;
    const cw = (box.wPct / 100) * video.videoWidth;
    const ch = (box.hPct / 100) * video.videoHeight;
    if (cw < 5 || ch < 5) return null;

    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    full.getContext("2d")?.drawImage(video, 0, 0);

    const crop = document.createElement("canvas");
    crop.width = cw;
    crop.height = ch;
    crop.getContext("2d")?.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
    return crop;
  }

  // The one auto phase-detection this local-OCR system attempts: a
  // readable in-game timer is a strong, text-based signal (unlike
  // pick/ban icons, which this console deliberately never tries to OCR —
  // see the note in the capture section below) that the game has moved
  // past the draft screen. Fires once per game.
  async function maybeAutoStartGame() {
    if (!match || !game) return;
    if (autoStartedGameId.current === game.id) return;
    if (match.state === "GAME_STARTED" || match.state === "GAME_FINISHED" || match.state === "SERIES_FINISHED") return;
    autoStartedGameId.current = game.id;
    const { error } = await supabase.from("matches").update({ state: "GAME_STARTED" }).eq("id", match.id);
    if (error) console.error("Failed to auto-set GAME_STARTED:", error.message);
    else loadAll();
  }

  async function captureTick() {
    const video = previewRef.current;
    const worker = workerRef.current;
    if (!video || !worker || video.videoWidth === 0) return;

    for (const { field } of CAPTURE_FIELDS) {
      const box = regions[field];
      if (!box) continue;
      const canvas = cropCanvasFor(video, box);
      if (!canvas) continue;

      try {
        const { data: { text } } = await worker.recognize(canvas);
        const trimmed = text.trim();
        setReadings((prev) => ({ ...prev, [field]: trimmed }));

        if (field === "kill_banner") {
          const found = OCR_KEYWORDS.find((k) => k.pattern.test(trimmed));
          if (found) setSuggestion({ type: found.type, raw: trimmed });
        }
        if (field === "timer") {
          const m = trimmed.match(/(\d{1,2}):(\d{2})/);
          if (m) {
            setMinute(Number(m[1]));
            maybeAutoStartGame();
          }
        }
      } catch (err) {
        console.error(`OCR error (${field})`, err);
      }
    }
  }

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      streamRef.current = stream;
      // previewRef.current is null here — the <video> only exists in the
      // DOM once captureActive is true, and this runs before that state
      // update is committed. Attaching srcObject was silently a no-op the
      // whole time (video always mounted with nothing attached, hence
      // permanently black regardless of what was shared). The actual
      // attach now happens in the effect below, which fires after React
      // has mounted the element.
      setCaptureActive(true);
      if (captureMode === "ai") {
        // 10s cadence, not 5s like the manual OCR loop — each tick is a
        // paid vision-model call (Groq), not a free local Tesseract read.
        intervalRef.current = setInterval(captureFrameAndAnalyze, 10000);
      } else {
        workerRef.current = await createWorker("eng");
        intervalRef.current = setInterval(captureTick, 5000);
      }
    } catch (err) {
      console.error("Could not start screen share for local capture", err);
    }
  }

  function stopCapture() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    workerRef.current?.terminate();
    setCaptureActive(false);
    setSuggestion(null);
    setAiDetection(null);
    setAiStatus(null);
  }

  // Runs after captureActive flips true and React has actually mounted the
  // <video> element — this is what attaches the shared stream, not
  // startCapture() itself (see the comment there).
  useEffect(() => {
    if (!captureActive || !streamRef.current || !previewRef.current) return;
    previewRef.current.srcObject = streamRef.current;
    previewRef.current.play().catch((err) => console.error("Preview play() failed", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureActive]);

  useEffect(() => {
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!calibratingField) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function handleCropMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    if (!calibratingField || !dragStart.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    const x = Math.min(dragStart.current.x, endX);
    const y = Math.min(dragStart.current.y, endY);
    const w = Math.abs(endX - dragStart.current.x);
    const h = Math.abs(endY - dragStart.current.y);
    saveRegion(calibratingField, {
      xPct: (x / rect.width) * 100,
      yPct: (y / rect.height) * 100,
      wPct: (w / rect.width) * 100,
      hPct: (h / rect.height) * 100,
    });
    dragStart.current = null;
    setCalibratingField(null);
  }

  async function confirmSuggestion() {
    if (!suggestion || !game) return;
    await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: suggestion.type,
      minute_mark: minute,
      source: "manual",
    });
    setSuggestion(null);
    loadAll();
  }

  async function applyGoldReading() {
    if (!game) return;
    const nums = readings.gold.match(/\d[\d,]*/g)?.map((n) => Number(n.replace(/,/g, "")));
    if (!nums || nums.length < 2) return;
    await supabase.from("net_worth_snapshots").insert({
      game_id: game.id,
      match_id: matchId,
      minute_mark: minute,
      team_a_gold: nums[0],
      team_b_gold: nums[1],
    });
  }

  async function setGameMap(map: string) {
    if (!game) return;
    const { error } = await supabase.from("games").update({ map }).eq("id", game.id);
    if (error) setError(error.message);
    else loadAll();
  }

  // Finishes the current game with a winner, then either closes out the
  // series (once a team hits the format's required win count) or advances
  // current_game_number so the next loadAll() auto-creates the next game —
  // this is what was missing for "per game result" to show anywhere.
  const SERIES_WINS_REQUIRED: Record<string, number> = { BO1: 1, BO2: 2, BO3: 2, BO5: 3, BO7: 4 };
  async function declareGameWinner(teamId: string) {
    if (!game || !match) return;
    if (!confirm("Finish this game with this team as the winner?")) return;

    const { error: gameErr } = await supabase
      .from("games")
      .update({ status: "finished", state: "GAME_FINISHED", winner_team_id: teamId, finished_at: new Date().toISOString() })
      .eq("id", game.id);
    if (gameErr) {
      setError(gameErr.message);
      return;
    }

    const allGames = [...pastGames, { ...game, winner_team_id: teamId }];
    const winsFor = (id: string) => allGames.filter((g) => g.winner_team_id === id).length;
    const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
    const seriesWinner = aWins >= required ? match.team_a?.id : bWins >= required ? match.team_b?.id : null;

    const { error } = seriesWinner
      ? await supabase
          .from("matches")
          .update({ status: "finished", state: "SERIES_FINISHED", series_winner_team_id: seriesWinner })
          .eq("id", match.id)
      : await supabase
          .from("matches")
          .update({ current_game_number: match.current_game_number + 1, state: "GAME_FINISHED" })
          .eq("id", match.id);
    if (error) setError(error.message);

    // The worker posts this automatically for Liquipedia-sourced matches,
    // but never sees local_ocr matches at all — post it here instead so
    // those results still reach Telegram.
    if (match.update_source === "local_ocr") {
      const winnerName = teamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      await postToTelegram(
        `🎮 <b>Game ${game.game_number} result</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${winnerName}</b>\n${match.tournament?.name}`,
        { entityType: "game", entityId: game.id, notificationType: "game_result" }
      );
      if (seriesWinner) {
        const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
        await postToTelegram(
          `🏆 <b>Match finished</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${seriesWinnerName}</b>\n${match.tournament?.name}`,
          { entityType: "match", entityId: match.id, notificationType: "match_finished" }
        );
      }
    }

    loadAll();
  }

  async function toggleUpdateSource() {
    if (!match) return;
    const next = match.update_source === "liquipedia" ? "local_ocr" : "liquipedia";
    await supabase.from("matches").update({ update_source: next }).eq("id", match.id);
    loadAll();
  }

  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!match || !game) return <p className="text-white/50 text-sm">Loading match...</p>;

  const embedUrl = youtubeEmbedUrl(match.youtube_url);

  // The starting five for this game = whoever has a logged pick, not the
  // whole roster (which included bench/subs never playing this game —
  // the source of "mistakenly taking other data than players"). Falls
  // back to the full roster, sorted the same way, until picks are logged
  // so the admin has someone to pick from. Both always sort left-to-right
  // by role: exp lane, jungler, mid laner, gold laner, roamer.
  function activeFive(teamId: string | undefined) {
    if (!teamId) return [];
    const picked = pickBans
      .filter((pb) => pb.type === "pick" && pb.team_id === teamId && pb.player_id)
      .map((pb) => players.find((p) => p.id === pb.player_id))
      .filter((p): p is Player => Boolean(p));
    const base = picked.length > 0 ? picked : players.filter((p) => p.team_id === teamId);
    return [...base].sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
  }
  const teamAPlayers = activeFive(match.team_a?.id);
  const teamBPlayers = activeFive(match.team_b?.id);
  const rosterFor = (teamId: string) => players.filter((p) => p.team_id === teamId);

  return (
    <div className="text-white space-y-8 max-w-6xl">
      <div>
        <h1 className="lv-heading text-lg">
          {match.team_a?.name} vs {match.team_b?.name}
        </h1>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <p className="text-xs text-white/50">{match.tournament?.name} · {match.format} · Game {game.game_number}</p>
          <span className="lv-badge bg-white/10 text-white/60">
            {match.state.replace(/_/g, " ")}
          </span>
          <button
            onClick={toggleUpdateSource}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              match.update_source === "liquipedia"
                ? "border-emerald-500/40 text-emerald-400"
                : "border-yellow-500/40 text-yellow-400"
            }`}
          >
            {match.update_source === "liquipedia"
              ? "🤖 Liquipedia auto ON — click to take over with local OCR"
              : "✋ Local OCR (this PC) — click to hand back to Liquipedia auto"}
          </button>
        </div>
        {match.state === "SERIES_FINISHED" && (
          <p className="text-sm text-emerald-400 mt-2">
            Series finished — winner: {match.series_winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
          </p>
        )}
      </div>

      {/* Game history — the per-game results that previously showed nowhere in this console */}
      {pastGames.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold text-sm text-white/60">Previous games</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {pastGames.map((g) => (
              <span key={g.id} className="px-3 py-1.5 rounded bg-white/5 border border-white/10">
                Game {g.game_number}
                {g.map && <span className="text-white/40"> · {g.map}</span>} —{" "}
                <strong>{g.winner_team_id === match.team_a?.id ? match.team_a?.name : g.winner_team_id === match.team_b?.id ? match.team_b?.name : "no winner set"}</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* This game: map + result */}
      <section className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-white/50">Map</label>
          <select
            value={game.map ?? ""}
            onChange={(e) => setGameMap(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="">Not set</option>
            {MAPS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        {game.status !== "finished" && match.state !== "SERIES_FINISHED" && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-white/50">Declare game {game.game_number} winner</label>
            {match.team_a && (
              <button onClick={() => declareGameWinner(match.team_a!.id)} className="lv-btn-ghost !px-3 !py-1.5">
                {match.team_a.name}
              </button>
            )}
            {match.team_b && (
              <button onClick={() => declareGameWinner(match.team_b!.id)} className="lv-btn-ghost !px-3 !py-1.5">
                {match.team_b.name}
              </button>
            )}
          </div>
        )}
        {game.status === "finished" && (
          <span className="lv-badge bg-emerald-500/15 text-emerald-400">
            Game {game.game_number} winner: {game.winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
          </span>
        )}
      </section>

      <div className="grid grid-cols-2 gap-6">
        {embedUrl && (
          <iframe
            src={embedUrl}
            className="w-full aspect-video rounded"
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        )}

        <div className="space-y-2">
          <label className="text-xs text-white/50">Game clock (minutes) — update this as you watch</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
              className="w-32 bg-black/30 border border-white/10 rounded px-3 py-2 text-lg font-bold"
            />
            <button
              onClick={logNetWorthSnapshot}
              className="text-xs border border-white/10 rounded px-3 py-2 hover:bg-white/10"
            >
              📸 Snapshot net worth
            </button>
          </div>
          <p className="text-[10px] text-white/40">
            Tap this every minute or two — it's what powers the live gold-difference graph on the public page.
          </p>
        </div>
      </div>

      {/* Players */}
      <section className="space-y-3">
        <h2 className="font-bold">Players</h2>
        <div className="flex gap-2 items-end">
          <input
            placeholder="Player IGN"
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={newPlayerTeam}
            onChange={(e) => setNewPlayerTeam(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          >
            <option value="">Team</option>
            {match.team_a && <option value={match.team_a.id}>{match.team_a.name}</option>}
            {match.team_b && <option value={match.team_b.id}>{match.team_b.name}</option>}
          </select>
          <button onClick={addPlayer} className="lv-btn-ghost">
            Add player
          </button>
        </div>
      </section>

      {/* Hero picks/bans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Hero picks & bans</h2>
          <button
            onClick={() => {
              const recap = [match.team_a, match.team_b]
                .map((team) => {
                  if (!team) return "";
                  const picks = pickBans
                    .filter((pb) => pb.team_id === team.id && pb.type === "pick")
                    .sort((a, b) => roleIndex(players.find((p) => p.id === a.player_id)?.role ?? null) - roleIndex(players.find((p) => p.id === b.player_id)?.role ?? null))
                    .map((pb) => `${pb.hero_name} (${players.find((p) => p.id === pb.player_id)?.ign ?? "?"})`)
                    .join(", ");
                  const bans = pickBans.filter((pb) => pb.team_id === team.id && pb.type === "ban").map((pb) => pb.hero_name).join(", ");
                  return `<b>${team.name}</b>\nPicks: ${picks || "—"}\nBans: ${bans || "—"}`;
                })
                .join("\n\n");
              postToTelegram(
                `📋 <b>Draft complete — Game ${game.game_number}</b>\n${match.tournament?.name}\n\n${recap}`,
                { entityType: "game", entityId: game.id, notificationType: "draft_result" }
              );
            }}
            className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
          >
            📢 Announce draft
          </button>
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <select
            value={pbTeam}
            onChange={(e) => {
              setPbTeam(e.target.value);
              setPbPlayer("");
            }}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          >
            <option value="">Team</option>
            {match.team_a && <option value={match.team_a.id}>{match.team_a.name}</option>}
            {match.team_b && <option value={match.team_b.id}>{match.team_b.name}</option>}
          </select>
          <select
            value={pbType}
            onChange={(e) => setPbType(e.target.value as "pick" | "ban")}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          >
            <option value="ban">Ban</option>
            <option value="pick">Pick</option>
          </select>
          {pbType === "pick" && (
            <select
              value={pbPlayer}
              onChange={(e) => setPbPlayer(e.target.value)}
              className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
            >
              <option value="">Player</option>
              {pbTeam &&
                rosterFor(pbTeam).map((p) => (
                  <option key={p.id} value={p.id}>{p.ign}{p.role ? ` (${p.role})` : ""}</option>
                ))}
            </select>
          )}
          <input
            placeholder="Hero name"
            value={pbHero}
            onChange={(e) => setPbHero(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <button onClick={logPickBan} className="lv-btn-ghost">
            Log
          </button>
        </div>

        {[match.team_a, match.team_b].map((team, idx) =>
          team ? (
            <div key={team.id} className="space-y-1">
              <p className="text-xs text-white/50">{team.name}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                {pickBans
                  .filter((pb) => pb.team_id === team.id && pb.type === "pick")
                  .sort((a, b) => roleIndex(players.find((p) => p.id === a.player_id)?.role ?? null) - roleIndex(players.find((p) => p.id === b.player_id)?.role ?? null))
                  .map((pb) => {
                    const player = players.find((p) => p.id === pb.player_id);
                    return (
                      <span key={pb.id} className="px-2 py-1 rounded bg-emerald-500/20 flex items-center gap-1.5">
                        ✅ {pb.hero_name}
                        {player && <span className="text-white/50">({player.ign}{player.role ? ` · ${player.role}` : ""})</span>}
                        <button onClick={() => deletePickBan(pb.id)} className="text-white/30 hover:text-red-400">✕</button>
                      </span>
                    );
                  })}
                {pickBans
                  .filter((pb) => pb.team_id === team.id && pb.type === "ban")
                  .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0))
                  .map((pb) => (
                    <span key={pb.id} className="px-2 py-1 rounded bg-red-500/20 flex items-center gap-1.5">
                      🚫 {pb.hero_name}
                      <button onClick={() => deletePickBan(pb.id)} className="text-white/30 hover:text-red-400">✕</button>
                    </span>
                  ))}
              </div>
            </div>
          ) : (
            <span key={idx} />
          )
        )}
      </section>

      {/* Scoreboard */}
      <section className="space-y-3">
        <h2 className="font-bold">Live scoreboard</h2>
        {[teamAPlayers, teamBPlayers].map((teamPlayers, idx) => (
          <div key={idx} className="space-y-2">
            <p className="text-xs text-white/50">{idx === 0 ? match.team_a?.name : match.team_b?.name}</p>
            {teamPlayers.map((p) => {
              const stat = stats.find((s) => s.player_id === p.id);
              return (
                <div key={p.id} className="flex gap-2 items-center text-sm">
                  <span className="w-24 truncate">{p.ign}</span>
                  <input
                    placeholder="Hero"
                    defaultValue={stat?.hero_name ?? ""}
                    onBlur={(e) => updateStat(p.id, "hero_name", e.target.value)}
                    className="w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                  />
                  {(["kills", "deaths", "assists"] as const).map((field) => (
                    <input
                      key={field}
                      type="number"
                      placeholder={field}
                      defaultValue={stat?.[field] ?? 0}
                      onBlur={(e) => updateStat(p.id, field, Number(e.target.value))}
                      className="w-14 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  ))}
                  <input
                    type="number"
                    placeholder="gold"
                    defaultValue={stat?.gold ?? 0}
                    onBlur={(e) => updateStat(p.id, "gold", Number(e.target.value))}
                    className="w-20 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                  />
                  <ItemRow onSave={(items) => saveItems(p.id, items)} />
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {/* Objectives */}
      <section className="space-y-3">
        <h2 className="font-bold">Objectives</h2>
        <div className="flex gap-6">
          {[match.team_a, match.team_b].map((team, idx) =>
            team ? (
              <div key={team.id} className="space-y-2">
                <p className="text-xs text-white/50">{team.name}</p>
                <div className="flex gap-2">
                  {["tower", "lord", "turtle", "base"].map((type) => (
                    <button
                      key={type}
                      onClick={() => logObjective(team.id, type)}
                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 capitalize"
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <span key={idx} />
            )
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {objectives.map((o) => (
            <span key={o.id} className="px-2 py-1 rounded bg-white/10 capitalize flex items-center gap-1.5">
              {o.minute_mark}&apos; {o.type} ({o.team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name})
              <button onClick={() => deleteObjective(o.id)} className="text-white/30 hover:text-red-400 normal-case">✕</button>
            </span>
          ))}
        </div>
      </section>

      {/* Key moments */}
      <section className="space-y-3">
        <h2 className="font-bold">Key moments</h2>
        <div className="flex gap-2 items-end">
          <select value={kmType} onChange={(e) => setKmType(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
            <option value="savage">Savage</option>
            <option value="maniac">Maniac</option>
            <option value="lord_steal">Lord steal</option>
            <option value="turtle_steal">Turtle steal</option>
            <option value="ace">Ace</option>
          </select>
          <select value={kmPlayer} onChange={(e) => setKmPlayer(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
            <option value="">Player (optional)</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>{p.ign}</option>
            ))}
          </select>
          <button onClick={logKeyMoment} className="lv-btn-ghost">
            Log moment
          </button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {keyMoments.map((km) => {
            const player = players.find((p) => p.id === km.player_id);
            return (
              <span key={km.id} className="px-2 py-1 rounded bg-signal/20 capitalize flex items-center gap-1.5">
                {km.minute_mark}&apos; {km.type.replace("_", " ")}{player ? ` — ${player.ign}` : ""}
                <button
                  onClick={() =>
                    postToTelegram(
                      `🔥 <b>${km.type.replace("_", " ").toUpperCase()}</b>${player ? ` — ${player.ign}` : ""}\n${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`,
                      { entityType: "key_moment", entityId: km.id, notificationType: "key_moment" }
                    )
                  }
                  className="text-white/30 hover:text-signal normal-case"
                  title="Post to Telegram"
                >
                  📢
                </button>
                <button onClick={() => deleteKeyMoment(km.id)} className="text-white/30 hover:text-red-400 normal-case">✕</button>
              </span>
            );
          })}
        </div>
      </section>

      {telegramStatus && (
        <p className="text-xs text-white/50 fixed bottom-4 right-4 bg-black/80 border border-white/10 rounded px-3 py-2 z-50">
          {telegramStatus}
        </p>
      )}

      {/* Local capture (admin PC) — only drives anything when this match is on local_ocr */}
      <section className="space-y-3 border-t border-white/10 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Local capture (this PC)</h2>
          {match.update_source === "local_ocr" && (
            <button
              onClick={captureActive ? stopCapture : startCapture}
              className={`text-xs rounded px-3 py-1.5 ${
                captureActive ? "bg-red-500/20 text-red-300" : "border border-white/10 hover:bg-white/10"
              }`}
            >
              {captureActive ? "Stop capture" : "Start capture"}
            </button>
          )}
        </div>

        {match.update_source !== "local_ocr" ? (
          <p className="text-xs text-white/40">
            This match is on Liquipedia auto. Switch update source to &quot;Local OCR&quot; above to take over
            with this PC&apos;s screen capture.
          </p>
        ) : (
          <>
            <div className="flex gap-2">
              <button
                onClick={() => !captureActive && setCaptureMode("ai")}
                disabled={captureActive}
                className={`text-[10px] rounded px-2 py-1 border ${
                  captureMode === "ai" ? "border-signal bg-signal/10 text-signal" : "border-white/10 text-white/50"
                } disabled:opacity-50`}
              >
                Full-frame AI (recommended)
              </button>
              <button
                onClick={() => !captureActive && setCaptureMode("manual")}
                disabled={captureActive}
                className={`text-[10px] rounded px-2 py-1 border ${
                  captureMode === "manual" ? "border-signal bg-signal/10 text-signal" : "border-white/10 text-white/50"
                } disabled:opacity-50`}
              >
                Manual region OCR (legacy)
              </button>
            </div>

            {captureMode === "ai" ? (
              <p className="text-[10px] text-white/40">
                Sends the whole captured frame to a vision model every 10s — no boxes to drag. Reads phase, game
                timer, draft picks/bans, kill banners, per-player K/D/A, and net worth, and applies what it finds
                directly (winner calls are only ever suggested, never auto-committed). Needs GROQ_API_KEY
                configured server-side.
              </p>
            ) : (
              <p className="text-[10px] text-white/40">
                Reads the match timer, team gold, and kill-banner text from calibrated crop regions —
                deterministic OCR running entirely in your browser, no AI involved. Hero picks/bans and
                per-player K/D/A aren&apos;t reliable to OCR this way (icons have no text, scoreboard rows vary
                too much) — keep using the pickers/inputs above for those, or switch to Full-frame AI.
              </p>
            )}

            {captureMode === "ai" && (
              <input
                value={overlayHint}
                onChange={(e) => setOverlayHint(e.target.value)}
                placeholder="Overlay hint (optional) — e.g. &quot;kill banners appear top-center in yellow text&quot;"
                className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
              />
            )}

            {captureActive && (
              <div className="space-y-3">
                <div
                  className="relative w-full max-w-md border border-white/10 rounded overflow-hidden"
                  onMouseDown={captureMode === "manual" ? handleCropMouseDown : undefined}
                  onMouseUp={captureMode === "manual" ? handleCropMouseUp : undefined}
                >
                  <video ref={previewRef} muted className="w-full block" />
                  {captureMode === "manual" &&
                    CAPTURE_FIELDS.map(({ field }) => {
                      const box = regions[field];
                      if (!box) return null;
                      return (
                        <div
                          key={field}
                          className={`absolute border-2 pointer-events-none ${
                            calibratingField === field ? "border-signal" : "border-white/40"
                          }`}
                          style={{
                            left: `${box.xPct}%`,
                            top: `${box.yPct}%`,
                            width: `${box.wPct}%`,
                            height: `${box.hPct}%`,
                          }}
                        />
                      );
                    })}
                </div>

                {captureMode === "manual" && (
                  <div className="grid grid-cols-3 gap-2">
                    {CAPTURE_FIELDS.map(({ field, label }) => (
                      <div key={field} className="border border-white/10 rounded p-2 space-y-1.5">
                        <p className="text-[10px] text-white/50">{label}</p>
                        <button
                          onClick={() => setCalibratingField(field)}
                          className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 w-full"
                        >
                          {calibratingField === field ? "Drag the area now..." : regions[field] ? "Recalibrate" : "Calibrate"}
                        </button>
                        <p className="text-xs text-white/70 truncate" title={readings[field]}>
                          {readings[field] || "—"}
                        </p>
                        {field === "gold" && readings.gold && (
                          <button
                            onClick={applyGoldReading}
                            className="text-[10px] bg-signal rounded px-2 py-1 w-full"
                          >
                            Apply as net worth snapshot
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {captureMode === "ai" && (
                  <div className="border border-white/10 rounded p-3 space-y-1 text-xs">
                    {aiStatus && <p className="text-red-400">{aiStatus}</p>}
                    {aiDetection ? (
                      <>
                        <p>
                          Phase: <strong>{aiDetection.phase}</strong>
                          {aiDetection.game_timer_mm_ss && <> · Timer: <strong>{aiDetection.game_timer_mm_ss}</strong></>}
                          {typeof aiDetection.confidence === "number" && (
                            <span className="text-white/40"> · confidence {Math.round(aiDetection.confidence * 100)}%</span>
                          )}
                        </p>
                        {aiDetection.draft_actions?.length > 0 && (
                          <p className="text-white/60">
                            Draft: {aiDetection.draft_actions.map((a) => `${a.type} ${a.hero_name} (${a.team_name})`).join(", ")}
                          </p>
                        )}
                        {aiDetection.player_stats?.length > 0 && (
                          <p className="text-white/60">
                            Stats read for: {aiDetection.player_stats.map((s) => s.player_name).join(", ")}
                          </p>
                        )}
                        {aiDetection.key_moment_banner !== "NONE" && (
                          <p className="text-yellow-300">
                            Key moment: {aiDetection.key_moment_banner}
                            {aiDetection.key_moment_player_name ? ` — ${aiDetection.key_moment_player_name}` : ""}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-white/40">Waiting for first frame…</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {suggestedWinner && match.team_a && match.team_b && (
              <div className="flex flex-wrap items-center gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded px-4 py-3">
                <span className="text-sm">
                  AI detected a possible winner:{" "}
                  <strong>{suggestedWinner === match.team_a.id ? match.team_a.name : match.team_b.name}</strong>
                </span>
                <button
                  onClick={() => {
                    declareGameWinner(suggestedWinner);
                    setSuggestedWinner(null);
                  }}
                  className="lv-btn-primary"
                >
                  Confirm & finish game
                </button>
                <button onClick={() => setSuggestedWinner(null)} className="lv-btn-ghost">
                  Dismiss
                </button>
              </div>
            )}

            {suggestion && (
              <div className="flex flex-wrap items-center gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded px-4 py-3">
                <span className="text-sm">
                  Detected: <strong className="uppercase">{suggestion.type.replace("_", " ")}</strong>{" "}
                  <span className="text-white/40">(&quot;{suggestion.raw}&quot;)</span>
                </span>
                <button onClick={confirmSuggestion} className="lv-btn-primary">
                  Log this
                </button>
                <button
                  onClick={() => setSuggestion(null)}
                  className="lv-btn-ghost"
                >
                  Dismiss
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ItemRow({ onSave }: { onSave: (items: string[]) => void }) {
  const [items, setItems] = useState<string[]>(["", "", "", "", "", ""]);
  return (
    <div className="flex gap-1">
      {items.map((val, i) => (
        <input
          key={i}
          value={val}
          onChange={(e) => {
            const next = [...items];
            next[i] = e.target.value;
            setItems(next);
          }}
          onBlur={() => onSave(items)}
          placeholder={`Item ${i + 1}`}
          className="w-16 bg-black/30 border border-white/10 rounded px-1 py-1 text-[10px]"
        />
      ))}
    </div>
  );
}
