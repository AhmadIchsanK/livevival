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
  custom_state_label: string | null;
  update_source: "liquipedia" | "local_ocr";
  series_winner_team_id: string | null;
  tournament_id: string | null;
  ocr_left_team_id: string | null;
  tournament: { name: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type Player = { id: string; team_id: string; ign: string; role: string | null };
type Game = {
  id: string;
  game_number: number;
  status: string;
  map: string | null;
  winner_team_id: string | null;
  clock_source: "ocr" | "manual";
  manual_time_seconds: number | null;
  manual_time_running: boolean;
  manual_time_started_at: string | null;
};
type FinishedGame = { id: string; game_number: number; status: string; map: string | null; winner_team_id: string | null; duration_seconds: number | null };
type PickBan = { id: string; team_id: string; player_id: string | null; hero_name: string; type: "pick" | "ban"; pick_order: number | null };
type PlayerStat = { id: string; player_id: string; hero_name: string | null; kills: number; deaths: number; assists: number; gold: number };
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null; created_at: string };
type KeyMoment = {
  id: string;
  type: string;
  player_id: string | null;
  team_id: string | null;
  description: string | null;
  minute_mark: number | null;
  is_key_moment: boolean;
  screenshot_url: string | null;
};
type MomentTemplate = { id: string; type: string; label_template: string; phase: string | null };
type Screenshot = { id: string; image_url: string; in_game_time: string | null; note: string | null; created_at: string };

// The handful of genuinely dramatic moment types that stand out inline in
// the moment list — everything else (phase changes, picks, custom notes)
// still appears in the same feed, just styled as a regular line item.
const KEY_MOMENT_TYPES = ["savage", "maniac", "lord_steal", "turtle_steal", "ace"];

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
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [minute, setMinute] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select(
        `id, youtube_url, format, current_game_number, state, custom_state_label, update_source, series_winner_team_id, tournament_id, ocr_left_team_id,
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
      .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at")
      .eq("match_id", matchId)
      .eq("game_number", m.current_game_number)
      .maybeSingle();

    if (!gameRow) {
      const { data: created, error: createErr } = await supabase
        .from("games")
        .insert({ match_id: matchId, game_number: m.current_game_number, status: "live" })
        .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at")
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
      const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: ss }] = await Promise.all([
        supabase.from("hero_picks_bans").select("id, team_id, player_id, hero_name, type, pick_order").eq("game_id", gid).order("pick_order"),
        supabase.from("player_stats").select("id, player_id, hero_name, kills, deaths, assists, gold").eq("game_id", gid),
        supabase.from("objectives").select("id, team_id, type, minute_mark, created_at").eq("game_id", gid).order("minute_mark"),
        supabase.from("key_moments").select("id, type, player_id, team_id, description, minute_mark, is_key_moment, screenshot_url").eq("game_id", gid).order("minute_mark"),
        supabase.from("game_screenshots").select("id, image_url, in_game_time, note, created_at").eq("game_id", gid).order("created_at"),
      ]);
      setPickBans((pb as PickBan[]) ?? []);
      setStats((ps as PlayerStat[]) ?? []);
      setObjectives((obj as Objective[]) ?? []);
      setKeyMoments((km as KeyMoment[]) ?? []);
      setScreenshots((ss as Screenshot[]) ?? []);
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
    return res.ok;
  }

  // Builds the same "team → picks/bans" recap block used both by the manual
  // "Announce draft" button and the automatic draft-finished notification.
  function buildDraftRecap(): string {
    if (!match) return "";
    return [match.team_a, match.team_b]
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
  }

  // Dumps everything currently on this page in one message — score so far,
  // this game's draft, KDA, and moment list — for whenever the admin wants
  // to share an update that doesn't fit one of the automatic triggers.
  async function shareFullMatchInfo() {
    if (!match || !game) return;
    const winsFor = (id: string) =>
      pastGames.filter((g) => g.winner_team_id === id).length + (game.winner_team_id === id ? 1 : 0);
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;

    const kdaLines = [match.team_a, match.team_b]
      .map((team) => {
        if (!team) return "";
        const lines = stats
          .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === team.id)
          .map((s) => {
            const p = players.find((pl) => pl.id === s.player_id);
            return `${p?.ign ?? "?"} (${s.hero_name ?? "?"}): ${s.kills}/${s.deaths}/${s.assists}`;
          })
          .join("\n");
        return lines ? `<b>${team.name}</b>\n${lines}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    const momentLines = keyMoments
      .map((km) => `${km.minute_mark}' ${km.description ?? km.type.replace(/_/g, " ")}`)
      .join("\n");

    const parts = [
      `📊 <b>Match update — Game ${game.game_number}</b>`,
      `${match.team_a?.name} ${aWins} – ${bWins} ${match.team_b?.name}\n${match.tournament?.name}`,
      buildDraftRecap(),
      kdaLines,
      momentLines ? `<b>Moments</b>\n${momentLines}` : "",
    ].filter(Boolean);

    await postToTelegram(parts.join("\n\n"), {
      entityType: "match",
      entityId: match.id,
      notificationType: "manual_share",
    });
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

  // ── Objectives (counters) ────────────────────────────────────────────
  // Stays an event-log table under the hood (one row per tower/lord/turtle
  // taken) — a counter UI is just "+" inserts a row, "−" removes the most
  // recently inserted row of that type/team, so the displayed number is
  // always just objectives.filter(...).length.
  const OBJECTIVE_TYPES = ["tower", "lord", "turtle"] as const;
  function objectiveCount(teamId: string, type: string) {
    return objectives.filter((o) => o.team_id === teamId && o.type === type).length;
  }
  async function incrementObjective(teamId: string, type: string) {
    if (!game) return;
    await supabase.from("objectives").insert({ game_id: game.id, match_id: matchId, team_id: teamId, type, minute_mark: minute });
    loadAll();
  }
  async function decrementObjective(teamId: string, type: string) {
    const mostRecent = objectives
      .filter((o) => o.team_id === teamId && o.type === type)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!mostRecent) return;
    const { error } = await supabase.from("objectives").delete().eq("id", mostRecent.id);
    if (error) setError(error.message);
    else loadAll();
  }

  // ── Key moments (template-driven) ────────────────────────────────────
  // Replaces free-typed moment logging with admin-managed prefilled
  // templates (/admin/moment-templates) — "Team {team} picks {hero}"
  // style placeholders get resolved from this match's own roster/hero
  // data rather than retyped by hand every time.
  const [momentTemplates, setMomentTemplates] = useState<MomentTemplate[]>([]);
  const [kmTemplateId, setKmTemplateId] = useState("");
  const [kmTeam, setKmTeam] = useState("");
  const [kmHero, setKmHero] = useState("");
  const [kmPlayer, setKmPlayer] = useState("");
  const [kmAttachScreenshot, setKmAttachScreenshot] = useState(false);
  const [kmCustomText, setKmCustomText] = useState("");
  const [kmMarkAsKey, setKmMarkAsKey] = useState(false);
  const [editingMomentId, setEditingMomentId] = useState<string | null>(null);
  const [editingMomentText, setEditingMomentText] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("moment_templates").select("id, type, label_template, phase").order("sort_order");
      setMomentTemplates((data as MomentTemplate[]) ?? []);
    })();
  }, []);

  const availableTemplates = momentTemplates.filter((t) => !t.phase || t.phase === match?.state);
  const selectedTemplate = momentTemplates.find((t) => t.id === kmTemplateId) ?? null;

  // Captures the current shared-screen frame and uploads it straight into
  // the moment being logged (key_moments.screenshot_url) instead of a
  // separate game_screenshots row — one attach action, one moment, one
  // image, rather than two records that have to be manually cross-referenced.
  function captureFrameBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const video = previewRef.current;
      if (!video || video.videoWidth === 0) {
        resolve(null);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
    });
  }
  async function uploadMomentScreenshot(): Promise<string | null> {
    if (!game) return null;
    const blob = await captureFrameBlob();
    if (!blob) return null;
    const path = `${game.id}/${Date.now()}-moment.jpg`;
    const { error: uploadErr } = await supabase.storage.from("key-moment-screenshots").upload(path, blob, {
      contentType: "image/jpeg",
    });
    if (uploadErr) {
      setError(uploadErr.message);
      return null;
    }
    const { data: pub } = supabase.storage.from("key-moment-screenshots").getPublicUrl(path);
    return pub.publicUrl;
  }

  async function logKeyMoment() {
    if (!game || !selectedTemplate) return;
    const teamName = kmTeam === match?.team_a?.id ? match.team_a?.name : kmTeam === match?.team_b?.id ? match?.team_b?.name : "";
    const heroName = heroes.find((h) => h.id === kmHero)?.name ?? "";
    const playerName = players.find((p) => p.id === kmPlayer)?.ign ?? "";
    // "custom" is the one type meant for genuine free typing, not a fixed
    // prefilled string — everything else still comes from the template.
    const description =
      selectedTemplate.type === "custom" && kmCustomText.trim()
        ? kmCustomText.trim()
        : selectedTemplate.label_template
            .replace("{team}", teamName)
            .replace("{hero}", heroName)
            .replace("{player}", playerName);
    // Savage/maniac/etc. are always key moments; a custom entry can be
    // explicitly flagged as one too (e.g. an admin's own big-play call).
    const isKeyMoment = KEY_MOMENT_TYPES.includes(selectedTemplate.type) || (selectedTemplate.type === "custom" && kmMarkAsKey);

    const screenshotUrl = kmAttachScreenshot && captureActive ? await uploadMomentScreenshot() : null;

    await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: selectedTemplate.type,
      description,
      player_id: kmPlayer || null,
      team_id: kmTeam || null,
      minute_mark: minute,
      source: "manual",
      is_key_moment: isKeyMoment,
      screenshot_url: screenshotUrl,
    });
    // The dramatic in-game moments auto-share — everything else (picks,
    // bans, phase changes, custom notes) stays manual via the 📢 button per
    // moment, since not every logged event is worth a push notification.
    if (isKeyMoment) {
      postToTelegram(`🔥 <b>${description}</b>\n${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`, {
        entityType: "key_moment",
        entityId: game.id,
        notificationType: "key_moment_auto",
      });
    }
    setKmTeam("");
    setKmHero("");
    setKmPlayer("");
    setKmAttachScreenshot(false);
    setKmCustomText("");
    setKmMarkAsKey(false);
    loadAll();
  }
  async function deleteKeyMoment(id: string) {
    const { error } = await supabase.from("key_moments").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }
  async function updateKeyMoment(id: string, description: string) {
    const { error } = await supabase.from("key_moments").update({ description }).eq("id", id);
    if (error) setError(error.message);
    else {
      setEditingMomentId(null);
      loadAll();
    }
  }

  // ── Game screenshots ────────────────────────────────────────────────
  // Replaces the old per-player item-build text inputs: instead of the
  // admin transcribing item icons into free-text slots, they capture (or
  // upload) an actual screenshot of the in-game inventory/scoreboard,
  // stamped with both the in-game timer and the real capture time.
  const [screenshotUploading, setScreenshotUploading] = useState(false);
  const [screenshotNote, setScreenshotNote] = useState("");

  async function uploadScreenshot(blob: Blob, noteOverride?: string) {
    if (!game) return;
    setScreenshotUploading(true);
    try {
      const path = `${game.id}/${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage.from("key-moment-screenshots").upload(path, blob, {
        contentType: "image/jpeg",
      });
      if (uploadErr) {
        setError(uploadErr.message);
        return;
      }
      const { data: pub } = supabase.storage.from("key-moment-screenshots").getPublicUrl(path);
      const inGameTime = `${String(minute).padStart(2, "0")}:00`;
      const { error: insertErr } = await supabase.from("game_screenshots").insert({
        game_id: game.id,
        match_id: matchId,
        image_url: pub.publicUrl,
        in_game_time: inGameTime,
        note: noteOverride ?? screenshotNote ?? null,
      });
      if (insertErr) {
        setError(insertErr.message);
        return;
      }
      setScreenshotNote("");
      loadAll();
    } finally {
      setScreenshotUploading(false);
    }
  }

  function captureScreenshotFromPreview(noteOverride?: string) {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) uploadScreenshot(blob, noteOverride);
    }, "image/jpeg", 0.85);
  }

  function handleScreenshotFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadScreenshot(file);
    e.target.value = "";
  }

  async function deleteScreenshot(id: string, imageUrl: string) {
    const { error: delErr } = await supabase.from("game_screenshots").delete().eq("id", id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    const path = imageUrl.split("/key-moment-screenshots/")[1];
    if (path) await supabase.storage.from("key-moment-screenshots").remove([path]);
    loadAll();
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
  // watching whatever is already playing.
  //
  // "left"/"right" fields track whichever physical side of the broadcast
  // overlay they're calibrated against — ocr_left_team_id (set once per
  // match below) is what resolves "left" to a real team, so the regions
  // themselves never need recalibrating when sides swap between games.
  type CaptureField =
    | "countdown"
    | "draft_timer_a"
    | "draft_timer_b"
    | "draft_picks_left"
    | "draft_picks_right"
    | "game_timer"
    | "objectives_left"
    | "objectives_right"
    | "kills_left"
    | "kills_right"
    | "networth_left"
    | "networth_right"
    | "kda_left"
    | "kda_right"
    | "kill_banner"
    | "victory_banner"
    | "pause_word";
  const CAPTURE_FIELDS: { field: CaptureField; label: string }[] = [
    { field: "countdown", label: "Pre-game countdown" },
    { field: "draft_timer_a", label: "Draft timer — Team A" },
    { field: "draft_timer_b", label: "Draft timer — Team B" },
    { field: "draft_picks_left", label: "Draft picks — left side (player + hero text)" },
    { field: "draft_picks_right", label: "Draft picks — right side (player + hero text)" },
    { field: "game_timer", label: "Game timer" },
    { field: "objectives_left", label: "Objectives — left (tower, lord, turtle)" },
    { field: "objectives_right", label: "Objectives — right (tower, lord, turtle)" },
    { field: "kills_left", label: "Team kills — left" },
    { field: "kills_right", label: "Team kills — right" },
    { field: "networth_left", label: "Net worth — left" },
    { field: "networth_right", label: "Net worth — right" },
    { field: "kda_left", label: "K/D/A — left (5 lines, one per player)" },
    { field: "kda_right", label: "K/D/A — right (5 lines, one per player)" },
    { field: "kill_banner", label: "Kill banner (Savage/Maniac/etc.)" },
    { field: "victory_banner", label: "Victory/defeat banner" },
    { field: "pause_word", label: "Pause indicator" },
  ];
  // Which crop regions are relevant to each phase — this is what makes each
  // phase's tracker genuinely different instead of one field list shown
  // regardless of what's actually on screen. Draft-finish (DRAFT_COMPLETE)
  // has no region of its own: its tracker is the staged-picks review panel
  // surfaced separately below. Bans stay manual/AI-only — ban slots show no
  // text on screen, only an icon, so there's nothing for deterministic OCR
  // to read there.
  const PHASE_CAPTURE_FIELDS: Record<string, CaptureField[]> = {
    MATCH_NOT_STARTED: ["countdown"],
    DRAFT_STARTED: ["draft_timer_a", "draft_timer_b", "draft_picks_left", "draft_picks_right"],
    DRAFT_COMPLETE: [],
    GAME_STARTED: [
      "game_timer",
      "objectives_left",
      "objectives_right",
      "kills_left",
      "kills_right",
      "networth_left",
      "networth_right",
      "kda_left",
      "kda_right",
      "kill_banner",
    ],
    GAME_FINISHED: ["victory_banner"],
    SERIES_FINISHED: [],
    TECHNICAL_PAUSE: ["pause_word"],
    CUSTOM: [],
  };
  const EMPTY_CAPTURE_RECORD = {
    countdown: null,
    draft_timer_a: null,
    draft_timer_b: null,
    draft_picks_left: null,
    draft_picks_right: null,
    game_timer: null,
    objectives_left: null,
    objectives_right: null,
    kills_left: null,
    kills_right: null,
    networth_left: null,
    networth_right: null,
    kda_left: null,
    kda_right: null,
    kill_banner: null,
    victory_banner: null,
    pause_word: null,
  };
  type RegionBox = { xPct: number; yPct: number; wPct: number; hPct: number };

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  // Guards the auto GAME_STARTED transition below so it only fires once
  // per game, not on every OCR tick that finds a readable timer.
  const autoStartedGameId = useRef<string | null>(null);
  // Counts consecutive ticks where game_timer failed to parse a valid
  // mm:ss while the match is GAME_STARTED — the one case reserved for
  // "tracker went blank" inference (technical pause), since a blank timer
  // alone can't otherwise distinguish a pause from a caster cutaway or the
  // game actually ending (those have their own, better signals: the
  // victory-banner OCR and the deterministic win-count math below).
  const unreadableTimerTicks = useRef(0);

  const [captureActive, setCaptureActive] = useState(false);
  const [calibratingField, setCalibratingField] = useState<CaptureField | null>(null);
  const [regions, setRegions] = useState<Record<CaptureField, RegionBox | null>>({ ...EMPTY_CAPTURE_RECORD });
  const [readings, setReadings] = useState<Record<CaptureField, string>>({
    ...EMPTY_CAPTURE_RECORD,
    countdown: "",
    draft_timer_a: "",
    draft_timer_b: "",
    draft_picks_left: "",
    draft_picks_right: "",
    game_timer: "",
    objectives_left: "",
    objectives_right: "",
    kills_left: "",
    kills_right: "",
    networth_left: "",
    networth_right: "",
    kda_left: "",
    kda_right: "",
    kill_banner: "",
    victory_banner: "",
    pause_word: "",
  });
  const [suggestion, setSuggestion] = useState<{ type: string; raw: string } | null>(null);
  const [consistencyWarning, setConsistencyWarning] = useState<string | null>(null);

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
  // Locked to "manual" from the UI (see the Local capture panel below) —
  // AI vision stays fully implemented but unreachable until manual OCR is
  // proven out, per explicit instruction. setCaptureMode is kept (not
  // deleted) since applyAiDetection/captureFrameAndAnalyze still exist and
  // will need it again once AI is re-enabled.
  const [captureMode, setCaptureMode] = useState<"ai" | "manual">("manual");
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
  // ocr_left_team_id resolves which real team the "left"-labeled regions
  // belong to for this match; unset defaults to team_a=left so a fresh
  // match still works before the admin explicitly sets it.
  function resolveLeftTeamId(): string | null {
    return match?.ocr_left_team_id ?? match?.team_a?.id ?? null;
  }
  function resolveRightTeamId(): string | null {
    const left = resolveLeftTeamId();
    return match?.team_a?.id === left ? match?.team_b?.id ?? null : match?.team_a?.id ?? null;
  }
  async function setOcrLeftTeam(teamId: string) {
    if (!match) return;
    await supabase.from("matches").update({ ocr_left_team_id: teamId || null }).eq("id", match.id);
    loadAll();
  }

  // Draft phases (DRAFT_STARTED/DRAFT_COMPLETE) never auto-write detected
  // picks/bans straight to the DB — a misread hero name during a fast draft
  // is much costlier to have gone live already than a stat glitch that
  // gets overwritten next tick. Detections pile up here for the admin to
  // review and explicitly push instead.
  const DRAFT_PHASES = ["DRAFT_STARTED", "DRAFT_COMPLETE"];
  const [stagedDraftActions, setStagedDraftActions] = useState<
    { type: "pick" | "ban"; team_name: string; hero_name: string }[]
  >([]);

  async function commitDraftAction(action: { type: "pick" | "ban"; team_name: string; hero_name: string }) {
    const teamId = matchTeamId(action.team_name);
    if (!teamId || !action.hero_name || !game) return;
    const alreadyLogged = pickBans.some(
      (pb) => pb.team_id === teamId && pb.hero_name.toLowerCase() === action.hero_name.toLowerCase() && pb.type === action.type
    );
    if (alreadyLogged) return;
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

  async function pushStagedDraftActions() {
    for (const action of stagedDraftActions) await commitDraftAction(action);
    setStagedDraftActions([]);
    loadAll();
  }

  function discardStagedDraftAction(index: number) {
    setStagedDraftActions((prev) => prev.filter((_, i) => i !== index));
  }

  async function applyAiDetection(detection: AiDetection) {
    if (!game || !match) return;

    const timerMatch = detection.game_timer_mm_ss?.match(/(\d{1,2}):(\d{2})/);
    if (timerMatch) {
      setMinute(Number(timerMatch[1]));
      updateGameClock(Number(timerMatch[1]), Number(timerMatch[2]));
    }
    if (detection.phase === "IN_GAME") maybeAutoStartGame();

    if (DRAFT_PHASES.includes(match.state)) {
      setStagedDraftActions((prev) => {
        const next = [...prev];
        for (const action of detection.draft_actions ?? []) {
          if (!action.hero_name) continue;
          const dupe = next.some(
            (a) => a.type === action.type && a.team_name === action.team_name && a.hero_name.toLowerCase() === action.hero_name.toLowerCase()
          );
          if (!dupe) next.push(action);
        }
        return next;
      });
    } else {
      for (const action of detection.draft_actions ?? []) await commitDraftAction(action);
    }

    // Game-ongoing's tracker area — stats, net worth, moment banners — only
    // applies while the admin actually has this phase selected, same
    // principle as the manual crop-region scoping above. Otherwise a stray
    // vision-model reading during e.g. a Technical pause could write
    // nonsense stats nobody asked for.
    if (match.state === "GAME_STARTED") {
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
            is_key_moment: KEY_MOMENT_TYPES.includes(detection.key_moment_banner.toLowerCase()),
          });
        }
      }
    }

    // Surfaced, not auto-applied — declareGameWinner() closes out the
    // series and already requires a confirm() click; too consequential to
    // fire from an unattended tick. Deliberately allowed during
    // GAME_STARTED (the natural transition — this is what tells the admin
    // the game just ended in the first place) as well as GAME_FINISHED;
    // excluded from earlier phases (draft, waiting) where a misread is
    // more likely to be an unrelated overlay.
    if (
      (match.state === "GAME_STARTED" || match.state === "GAME_FINISHED") &&
      (detection.phase === "VICTORY_DEFEAT_SCREEN" || detection.phase === "POST_GAME_STATS") &&
      detection.winning_team_name
    ) {
      const teamId = matchTeamId(detection.winning_team_name);
      if (teamId) setSuggestedWinner(teamId);
    }

    loadAll();
  }

  async function captureFrameAndAnalyze() {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) return;

    // Vision models tokenize images by pixel area, not file size — sending
    // the full 1920x1080 (or higher) capture straight through burned ~6.2k
    // of an 8k tokens-per-minute free-tier budget on a SINGLE frame,
    // guaranteeing a 429 on every request regardless of which vision model
    // is behind it. On-screen HUD text/timer/KDA is still perfectly
    // readable well below full resolution, so downscale to a fixed max
    // width before encoding — this is the actual fix, independent of model
    // choice.
    const MAX_WIDTH = 960;
    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.6);

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
    if (!matchId || !match?.tournament_id) return;
    (async () => {
      // Tournament-wide defaults first, then match-specific rows layered on
      // top — a match that was never calibrated inherits the tournament's
      // saved regions; one that was calibrated keeps its own. "overlay_hint"
      // is a text-only field (crop-region columns stay null for it) reusing
      // this same table/scoping instead of a dedicated one.
      const [{ data: tournamentDefaults }, { data: matchRegions }] = await Promise.all([
        supabase.from("capture_regions").select("field, x_pct, y_pct, w_pct, h_pct, hint_text").eq("tournament_id", match.tournament_id),
        supabase.from("capture_regions").select("field, x_pct, y_pct, w_pct, h_pct, hint_text").eq("match_id", matchId),
      ]);
      setRegions((prev) => {
        const next = { ...prev };
        for (const r of tournamentDefaults ?? []) {
          if (r.field === "overlay_hint") continue;
          next[r.field as CaptureField] = { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct };
        }
        for (const r of matchRegions ?? []) {
          if (r.field === "overlay_hint") continue;
          next[r.field as CaptureField] = { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct };
        }
        return next;
      });
      const tournamentHint = tournamentDefaults?.find((r) => r.field === "overlay_hint")?.hint_text;
      const matchHint = matchRegions?.find((r) => r.field === "overlay_hint")?.hint_text;
      if (matchHint ?? tournamentHint) setOverlayHint(matchHint ?? tournamentHint ?? "");
    })();
  }, [matchId, match?.tournament_id]);

  async function saveRegion(field: CaptureField, box: RegionBox) {
    setRegions((prev) => ({ ...prev, [field]: box }));
    await supabase.from("capture_regions").upsert(
      { match_id: matchId, field, x_pct: box.xPct, y_pct: box.yPct, w_pct: box.wPct, h_pct: box.hPct },
      { onConflict: "match_id,field" }
    );
  }
  async function clearRegion(field: CaptureField) {
    setRegions((prev) => ({ ...prev, [field]: null }));
    setReadings((prev) => ({ ...prev, [field]: "" }));
    await supabase.from("capture_regions").delete().eq("match_id", matchId).eq("field", field);
  }

  const [savedDefaultField, setSavedDefaultField] = useState<CaptureField | null>(null);
  async function saveRegionAsTournamentDefault(field: CaptureField) {
    const box = regions[field];
    if (!box || !match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      { tournament_id: match.tournament_id, field, x_pct: box.xPct, y_pct: box.yPct, w_pct: box.wPct, h_pct: box.hPct },
      { onConflict: "tournament_id,field" }
    );
    setSavedDefaultField(field);
    setTimeout(() => setSavedDefaultField(null), 2000);
  }

  async function saveOverlayHint() {
    if (!matchId) return;
    await supabase.from("capture_regions").upsert(
      { match_id: matchId, field: "overlay_hint", hint_text: overlayHint || null },
      { onConflict: "match_id,field" }
    );
  }

  const [overlayHintSavedAsDefault, setOverlayHintSavedAsDefault] = useState(false);
  async function saveOverlayHintAsTournamentDefault() {
    if (!match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      { tournament_id: match.tournament_id, field: "overlay_hint", hint_text: overlayHint || null },
      { onConflict: "tournament_id,field" }
    );
    setOverlayHintSavedAsDefault(true);
    setTimeout(() => setOverlayHintSavedAsDefault(false), 2000);
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

  // Persists the full mm:ss reading (not just the minute used for
  // minute_mark on logged events) so the public page can show a real
  // running game clock instead of only updating once per admin action.
  // Client-side ticking (in the public page) fills the gap between these
  // writes, using current_time_updated_at as the anchor.
  const lastPersistedSeconds = useRef<number | null>(null);
  async function updateGameClock(mm: number, ss: number) {
    if (!game) return;
    const totalSeconds = mm * 60 + ss;
    if (totalSeconds === lastPersistedSeconds.current) return;
    lastPersistedSeconds.current = totalSeconds;
    await supabase
      .from("games")
      .update({ current_time_seconds: totalSeconds, current_time_updated_at: new Date().toISOString() })
      .eq("id", game.id);
  }

  // ── Manual stopwatch (OCR fallback) ──────────────────────────────────
  // Same anchor-based ticking idea as the OCR clock above: manual_time_seconds
  // is the last value the admin set, manual_time_started_at is when the
  // stopwatch was (re)started from that value, and both the admin console
  // and the public page compute "now" by adding elapsed real time on top —
  // no per-second write loop needed while it's just running.
  function manualElapsedSeconds(g: Game): number {
    if (!g.manual_time_running || !g.manual_time_started_at) return g.manual_time_seconds ?? 0;
    return (g.manual_time_seconds ?? 0) + Math.floor((Date.now() - new Date(g.manual_time_started_at).getTime()) / 1000);
  }
  async function startManualClock() {
    if (!game) return;
    await supabase
      .from("games")
      .update({ manual_time_running: true, manual_time_started_at: new Date().toISOString(), manual_time_seconds: manualElapsedSeconds(game) })
      .eq("id", game.id);
    loadAll();
  }
  async function pauseManualClock() {
    if (!game) return;
    await supabase
      .from("games")
      .update({ manual_time_running: false, manual_time_seconds: manualElapsedSeconds(game), manual_time_started_at: null })
      .eq("id", game.id);
    loadAll();
  }
  async function setManualClockSeconds(totalSeconds: number) {
    if (!game) return;
    await supabase
      .from("games")
      .update({
        manual_time_seconds: Math.max(0, totalSeconds),
        manual_time_started_at: game.manual_time_running ? new Date().toISOString() : null,
      })
      .eq("id", game.id);
    loadAll();
  }
  async function adjustManualClock(deltaSeconds: number) {
    if (!game) return;
    await setManualClockSeconds(manualElapsedSeconds(game) + deltaSeconds);
  }
  async function setClockSource(source: "ocr" | "manual") {
    if (!game) return;
    await supabase.from("games").update({ clock_source: source }).eq("id", game.id);
    loadAll();
  }

  // Same pattern as updateGameClock but for the two other phase-scoped
  // clocks — Waiting's pre-game countdown and Draft's per-team pick timer —
  // each on its own last-persisted guard so the three never clobber one
  // another's dedup state.
  const lastPersistedCountdown = useRef<number | null>(null);
  async function updateCountdown(mm: number, ss: number) {
    if (!match) return;
    const totalSeconds = mm * 60 + ss;
    if (totalSeconds === lastPersistedCountdown.current) return;
    lastPersistedCountdown.current = totalSeconds;
    await supabase
      .from("matches")
      .update({ countdown_seconds: totalSeconds, countdown_updated_at: new Date().toISOString() })
      .eq("id", match.id);
  }

  const lastPersistedDraftTimers = useRef<{ a: number | null; b: number | null }>({ a: null, b: null });
  async function updateDraftTimer(side: "a" | "b", totalSeconds: number) {
    if (!match) return;
    if (totalSeconds === lastPersistedDraftTimers.current[side]) return;
    lastPersistedDraftTimers.current[side] = totalSeconds;
    const column = side === "a" ? "draft_timer_a_seconds" : "draft_timer_b_seconds";
    await supabase
      .from("matches")
      .update({ [column]: totalSeconds, draft_timer_updated_at: new Date().toISOString() })
      .eq("id", match.id);
  }

  function guessWinnerFromText(text: string): string | null {
    const n = normalize(text);
    if (match?.team_a && n.includes(normalize(match.team_a.name))) return match.team_a.id;
    if (match?.team_b && n.includes(normalize(match.team_b.name))) return match.team_b.id;
    return null;
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

  // Best-effort line parser shared by draft-pick and K/D/A regions: scans
  // each OCR'd line for a known hero name and a known player ign as
  // substrings (fuzzy via normalize()) rather than assuming a fixed column
  // layout, since the exact overlay text format varies by tournament.
  function findPlayerAndHeroInLine(line: string, teamId: string | null) {
    const teamPlayers = teamId ? players.filter((p) => p.team_id === teamId) : players;
    const n = normalize(line);
    const player = teamPlayers.find((p) => n.includes(normalize(p.ign)));
    const hero = heroes.find((h) => n.includes(normalize(h.name)));
    return { player, hero };
  }
  function parseDraftPickLines(text: string, teamId: string | null): { player: string; hero: string }[] {
    const results: { player: string; hero: string }[] = [];
    for (const rawLine of text.split(/\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const { player, hero } = findPlayerAndHeroInLine(line, teamId);
      if (player && hero) results.push({ player: player.ign, hero: hero.name });
    }
    return results;
  }
  function parseKdaLines(text: string, teamId: string | null) {
    const results: { playerId: string; heroName: string | null; kills: number; deaths: number; assists: number }[] = [];
    for (const rawLine of text.split(/\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const kda = line.match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (!kda) continue;
      const { player, hero } = findPlayerAndHeroInLine(line, teamId);
      if (!player) continue;
      results.push({ playerId: player.id, heroName: hero?.name ?? null, kills: Number(kda[1]), deaths: Number(kda[2]), assists: Number(kda[3]) });
    }
    return results;
  }
  async function applyObjectiveReading(teamId: string, text: string) {
    const nums = text.match(/\d+/g)?.map(Number);
    if (!nums || nums.length < 3) return;
    const targets: [string, number][] = [
      ["tower", nums[0]],
      ["lord", nums[1]],
      ["turtle", nums[2]],
    ];
    for (const [type, target] of targets) {
      const current = objectiveCount(teamId, type);
      for (let i = current; i < target; i++) await incrementObjective(teamId, type);
    }
  }

  async function captureTick() {
    const video = previewRef.current;
    const worker = workerRef.current;
    if (!video || !worker || video.videoWidth === 0) return;

    // Only scan the fields that matter for whatever phase the admin has
    // this match set to right now — this is what makes each phase's
    // tracker genuinely distinct instead of always reading the same trio
    // regardless of what's actually on screen.
    const activeFields = PHASE_CAPTURE_FIELDS[match?.state ?? ""] ?? [];
    const leftTeamId = resolveLeftTeamId();
    const rightTeamId = resolveRightTeamId();
    // Collected across the loop and applied once at the end, since both
    // sides of a paired region (net worth, K/D/A) need to be read before
    // they can be cross-checked or combined into one write.
    let networthLeft: number | null = null;
    let networthRight: number | null = null;
    let kdaLeftParsed: ReturnType<typeof parseKdaLines> = [];
    let kdaRightParsed: ReturnType<typeof parseKdaLines> = [];

    for (const field of activeFields) {
      const box = regions[field];
      if (!box) continue;
      const canvas = cropCanvasFor(video, box);
      if (!canvas) continue;

      try {
        const { data: { text } } = await worker.recognize(canvas);
        const trimmed = text.trim();
        setReadings((prev) => ({ ...prev, [field]: trimmed }));
        const mmss = trimmed.match(/(\d{1,2}):(\d{2})/);
        const secondsOnly = trimmed.match(/^(\d{1,3})$/);

        if (field === "kill_banner") {
          const found = OCR_KEYWORDS.find((k) => k.pattern.test(trimmed));
          if (found) setSuggestion({ type: found.type, raw: trimmed });
        }
        if (field === "game_timer") {
          if (mmss) {
            unreadableTimerTicks.current = 0;
            setMinute(Number(mmss[1]));
            updateGameClock(Number(mmss[1]), Number(mmss[2]));
            maybeAutoStartGame();
          } else if (match?.state === "GAME_STARTED") {
            // The one case reserved for "tracker went blank" inference — see
            // the comment on unreadableTimerTicks above.
            unreadableTimerTicks.current += 1;
            if (unreadableTimerTicks.current === 3) {
              setSuggestion({ type: "game_pause", raw: "Game timer unreadable for 3 consecutive ticks" });
            }
          }
        }
        if (field === "countdown") {
          if (mmss) updateCountdown(Number(mmss[1]), Number(mmss[2]));
          else if (secondsOnly) updateCountdown(0, Number(secondsOnly[1]));
        }
        if (field === "draft_timer_a" || field === "draft_timer_b") {
          const side = field === "draft_timer_a" ? "a" : "b";
          if (mmss) updateDraftTimer(side, Number(mmss[1]) * 60 + Number(mmss[2]));
          else if (secondsOnly) updateDraftTimer(side, Number(secondsOnly[1]));
        }
        if (field === "draft_picks_left" || field === "draft_picks_right") {
          const teamId = field === "draft_picks_left" ? leftTeamId : rightTeamId;
          const teamName = teamId === match?.team_a?.id ? match?.team_a?.name : match?.team_b?.name;
          if (teamName) {
            // Player attribution isn't part of the shared staged-action shape
            // (same limitation the AI-vision draft path already has) — the
            // player match is only used here to increase confidence that a
            // line is really a pick line, not junk OCR noise.
            const pairs = parseDraftPickLines(trimmed, teamId);
            setStagedDraftActions((prev) => {
              const next = [...prev];
              for (const { hero } of pairs) {
                const dupe = next.some((a) => a.type === "pick" && a.team_name === teamName && a.hero_name.toLowerCase() === hero.toLowerCase());
                if (!dupe) next.push({ type: "pick", team_name: teamName, hero_name: hero });
              }
              return next;
            });
          }
        }
        if (field === "objectives_left" && leftTeamId) await applyObjectiveReading(leftTeamId, trimmed);
        if (field === "objectives_right" && rightTeamId) await applyObjectiveReading(rightTeamId, trimmed);
        if (field === "networth_left") {
          const n = trimmed.match(/\d[\d,]*/);
          if (n) networthLeft = Number(n[0].replace(/,/g, ""));
        }
        if (field === "networth_right") {
          const n = trimmed.match(/\d[\d,]*/);
          if (n) networthRight = Number(n[0].replace(/,/g, ""));
        }
        if (field === "kda_left") kdaLeftParsed = parseKdaLines(trimmed, leftTeamId);
        if (field === "kda_right") kdaRightParsed = parseKdaLines(trimmed, rightTeamId);
        if (field === "victory_banner" && /victory|defeat|win/i.test(trimmed)) {
          const teamId = guessWinnerFromText(trimmed);
          if (teamId) setSuggestedWinner(teamId);
        }
        if (field === "pause_word" && /pause/i.test(trimmed)) {
          setSuggestion({ type: "game_pause", raw: trimmed });
        }
      } catch (err) {
        console.error(`OCR error (${field})`, err);
      }
    }

    // Net worth: only worth a snapshot once we actually have both sides —
    // feeds the same net_worth_snapshots table the manual "Snapshot net
    // worth" button already writes to.
    if (networthLeft != null && networthRight != null && game && match) {
      const teamAGold = leftTeamId === match.team_a?.id ? networthLeft : networthRight;
      const teamBGold = leftTeamId === match.team_a?.id ? networthRight : networthLeft;
      await supabase.from("net_worth_snapshots").insert({ game_id: game.id, match_id: matchId, minute_mark: minute, team_a_gold: teamAGold, team_b_gold: teamBGold });
    }

    // K/D/A: same auto-upsert precedent already used by the AI-vision path
    // (applyAiDetection) — a misread here just gets corrected by the next
    // tick or a manual edit in Live scoreboard, unlike draft picks (staged,
    // reviewed, pushed explicitly) where a wrong write is a one-time event
    // that's costlier to have gone live.
    if (game) {
      for (const row of [...kdaLeftParsed, ...kdaRightParsed]) {
        await supabase.from("player_stats").upsert(
          { game_id: game.id, match_id: matchId, player_id: row.playerId, hero_name: row.heroName, hero_id: matchHeroId(row.heroName), kills: row.kills, deaths: row.deaths, assists: row.assists },
          { onConflict: "game_id,player_id" }
        );
      }
    }

    // Consistency checks — dismissible warnings only, never block a write.
    const leftIds = new Set(kdaLeftParsed.map((r) => r.playerId));
    const crossedSides = kdaRightParsed.some((r) => leftIds.has(r.playerId));
    const leftHeroes = kdaLeftParsed.map((r) => r.heroName).filter(Boolean);
    const rightHeroes = kdaRightParsed.map((r) => r.heroName).filter(Boolean);
    const duplicateHero = leftHeroes.find((h) => rightHeroes.includes(h));
    if (crossedSides) setConsistencyWarning("Same player matched on both K/D/A regions — check ocr_left team mapping or region calibration.");
    else if (duplicateHero) setConsistencyWarning(`"${duplicateHero}" matched as picked on both teams — check hero OCR/roster data.`);
    else setConsistencyWarning(null);

    if (game && (kdaLeftParsed.length > 0 || kdaRightParsed.length > 0)) loadAll();
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
        // 60s cadence, not 5s like the manual OCR loop. Confirmed against
        // two real 429s in production that downscaling the frame only
        // trims request size modestly (~6045 -> ~5045 tokens) — this vision
        // model evidently normalizes images to something close to a fixed
        // internal size, so it doesn't scale down much further with input
        // resolution. Against an 8000 tokens-per-minute free-tier budget,
        // a ~5000-token request only has room for one per rolling minute;
        // anything faster was guaranteed to fail on most ticks.
        intervalRef.current = setInterval(captureFrameAndAnalyze, 60000);
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
    const video = previewRef.current;
    video.srcObject = streamRef.current;
    video.play().catch((err) => console.error("Preview play() failed", err));

    if (captureMode !== "ai") return;
    // setInterval (in startCapture) never fires its callback immediately —
    // only after the first full 60s pacing window — so without this, the
    // console sits on "Waiting for first frame..." for a full minute after
    // every "Start capture" click, which reads as hung rather than paced.
    // The 60s budget only needs to apply *between* calls, so fire one as
    // soon as the video actually has a frame ready instead.
    const fireFirstFrame = () => captureFrameAndAnalyze();
    if (video.readyState >= 1) fireFirstFrame(); // HAVE_METADATA already reached
    else video.addEventListener("loadedmetadata", fireFirstFrame, { once: true });
    return () => video.removeEventListener("loadedmetadata", fireFirstFrame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureActive]);

  useEffect(() => {
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!match || !DRAFT_PHASES.includes(match.state)) setStagedDraftActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.state]);

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
      is_key_moment: KEY_MOMENT_TYPES.includes(suggestion.type),
    });
    setSuggestion(null);
    loadAll();
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

  // Full reset for a Normal match gone wrong (bad sync, wrong teams matched,
  // etc.) — every child table keyed by match_id, then the games themselves,
  // then the match row back to its pre-anything state so the next sync (or
  // manual entry) starts clean instead of layering on top of stale rows.
  async function resetMatch() {
    if (!match) return;
    if (
      !confirm(
        "Reset this entire match? This deletes all games, picks/bans, stats, objectives, and moments for it, and reverts it to Match not started. This can't be undone."
      )
    )
      return;
    await Promise.all([
      supabase.from("hero_picks_bans").delete().eq("match_id", match.id),
      supabase.from("player_stats").delete().eq("match_id", match.id),
      supabase.from("objectives").delete().eq("match_id", match.id),
      supabase.from("net_worth_snapshots").delete().eq("match_id", match.id),
      supabase.from("game_screenshots").delete().eq("match_id", match.id),
      supabase.from("key_moments").delete().eq("match_id", match.id),
    ]);
    await supabase.from("games").delete().eq("match_id", match.id);
    const { error } = await supabase
      .from("matches")
      .update({ state: "MATCH_NOT_STARTED", status: "scheduled", current_game_number: 1, series_winner_team_id: null })
      .eq("id", match.id);
    if (error) setError(error.message);
    loadAll();
  }

  const MATCH_PHASES = [
    "MATCH_NOT_STARTED", "DRAFT_STARTED", "DRAFT_COMPLETE", "GAME_STARTED",
    "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE", "CUSTOM",
  ];
  // What this phase's tracker area actually does — each phase behaves
  // differently, not just a label on the same always-on tracker.
  const PHASE_TRACKER_HINTS: Record<string, string> = {
    MATCH_NOT_STARTED: "Waiting — tracker reads a pre-game countdown, shown live on the public page. No countdown found usually means TVC/caster session; use Custom if so.",
    DRAFT_STARTED: "Drafting — reads each team's per-pick countdown, plus picks (player + hero text) from the two draft-picks regions, staged below for review before pushing. Bans stay manual — ban slots show no text, only an icon.",
    DRAFT_COMPLETE: "Drafting finished — any picks still staged below can be reviewed and pushed. Nothing writes to the draft automatically.",
    GAME_STARTED: "Game ongoing — the main event: game timer, objectives, kills, net worth, and per-player K/D/A all track here (one region per side), applying automatically each tick. Set which side is \"left\" below.",
    GAME_FINISHED: "Game finished — tracker optionally reads a victory/defeat banner to suggest a winner; otherwise declare the winner manually below.",
    SERIES_FINISHED: "Match finished — capture is no longer needed for this series.",
    TECHNICAL_PAUSE: "Technical pause — tracker just looks for the word \"pause\" to confirm what you already flagged manually.",
    CUSTOM: "Custom phase — no dedicated tracker; use the label above to describe what's actually happening.",
  };
  const [customLabelDraft, setCustomLabelDraft] = useState("");
  async function setMatchPhase(newState: string) {
    if (!match) return;
    const previousState = match.state;
    const payload: { state: string; custom_state_label?: string | null } = { state: newState };
    if (newState !== "CUSTOM") payload.custom_state_label = null;
    const { error } = await supabase.from("matches").update(payload).eq("id", match.id);
    if (error) {
      setError(error.message);
      return;
    }
    // Only Hot matches get a moment log at all (Normal matches hide that
    // section entirely — see the update_source check further down), so
    // only they get phase transitions recorded into it.
    if (game && match.update_source === "local_ocr" && newState !== previousState) {
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "phase_change",
        description: `Phase changed to ${newState.replace(/_/g, " ")}`,
        minute_mark: minute,
        source: "manual",
      });

      // Hot matches get a handful of phase transitions auto-shared to
      // Telegram — the worker never sees local_ocr matches at all (see the
      // postToTelegram comment above), so nothing else announces these.
      if (newState !== previousState && game) {
        const header = `${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`;
        if (newState === "DRAFT_STARTED") {
          await postToTelegram(`✏️ <b>Draft started — Game ${game.game_number}</b>\n${header}`, {
            entityType: "match",
            entityId: match.id,
            notificationType: "draft_started",
          });
        } else if (newState === "DRAFT_COMPLETE") {
          await postToTelegram(
            `📋 <b>Draft complete — Game ${game.game_number}</b>\n${header}\n\n${buildDraftRecap()}`,
            { entityType: "game", entityId: game.id, notificationType: "draft_result" }
          );
        } else if (newState === "GAME_STARTED") {
          await postToTelegram(`🎮 <b>Game ${game.game_number} ongoing</b>\n${header}`, {
            entityType: "game",
            entityId: game.id,
            notificationType: "game_started",
          });
        }
      }
    }
    loadAll();
  }
  async function saveCustomLabel() {
    if (!match) return;
    await supabase.from("matches").update({ custom_state_label: customLabelDraft }).eq("id", match.id);
    loadAll();
  }

  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!match || !game) return <p className="text-white/50 text-sm">Loading match...</p>;

  const embedUrl = youtubeEmbedUrl(match.youtube_url);
  const activeCaptureFields = CAPTURE_FIELDS.filter((f) => (PHASE_CAPTURE_FIELDS[match.state] ?? []).includes(f.field));

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
          <select
            value={match.state}
            onChange={(e) => setMatchPhase(e.target.value)}
            title="Manual phase override — useful for technical pauses or anything OCR/Liquipedia sync can't reflect on its own"
            className="lv-badge bg-white/10 text-white/60 border-none"
          >
            {MATCH_PHASES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
          {match.state === "CUSTOM" && (
            <span className="flex items-center gap-1">
              <input
                value={customLabelDraft || match.custom_state_label || ""}
                onChange={(e) => setCustomLabelDraft(e.target.value)}
                placeholder="e.g. TVC / caster session"
                className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs w-48"
              />
              <button onClick={saveCustomLabel} className="lv-btn-ghost !px-2 !py-1 text-xs">Save</button>
            </span>
          )}
          <button
            onClick={toggleUpdateSource}
            title="Normal matches sync automatically from Liquipedia (score, picks/bans, VOD only). Hot matches are fully admin/OCR-controlled (adds KDA, items, moment log)."
            className={`text-[10px] px-2 py-0.5 rounded border ${
              match.update_source === "liquipedia"
                ? "border-emerald-500/40 text-emerald-400"
                : "border-signal/50 text-signal"
            }`}
          >
            {match.update_source === "liquipedia"
              ? "📡 Normal match — click to make this a Hot match"
              : "🔥 Hot match — click to hand back to Normal (Liquipedia auto)"}
          </button>
          <button onClick={shareFullMatchInfo} className="text-[10px] border border-white/10 rounded px-2 py-0.5 hover:bg-white/10">
            📢 Share everything to Telegram
          </button>
          {match.update_source !== "local_ocr" && (
            <button
              onClick={resetMatch}
              title="Deletes all games, picks/bans, stats, and objectives for this match and reverts it to Match not started"
              className="text-[10px] border border-red-500/30 text-red-400 rounded px-2 py-0.5 hover:bg-red-500/10"
            >
              ⟲ Reset match
            </button>
          )}
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

      <div className={`grid gap-6 ${match.update_source === "local_ocr" ? "grid-cols-2" : "grid-cols-1"}`}>
        {embedUrl && (
          <iframe
            src={embedUrl}
            className="w-full aspect-video rounded"
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        )}

        {match.update_source === "local_ocr" && (
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

            <label className="text-xs text-white/50 block pt-2">Public clock source</label>
            <div className="flex gap-1">
              {(["ocr", "manual"] as const).map((src) => (
                <button
                  key={src}
                  onClick={() => setClockSource(src)}
                  className={`text-[10px] px-2 py-1 rounded border ${
                    game.clock_source === src ? "border-signal text-signal" : "border-white/10 text-white/50"
                  }`}
                >
                  {src === "ocr" ? "OCR clock" : "Manual stopwatch"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-lg font-bold tabular-nums w-16">
                {String(Math.floor(manualElapsedSeconds(game) / 60)).padStart(2, "0")}:
                {String(manualElapsedSeconds(game) % 60).padStart(2, "0")}
              </span>
              {game.manual_time_running ? (
                <button onClick={pauseManualClock} className="text-xs border border-white/10 rounded px-2 py-1.5 hover:bg-white/10">
                  ⏸ Pause
                </button>
              ) : (
                <button onClick={startManualClock} className="text-xs border border-white/10 rounded px-2 py-1.5 hover:bg-white/10">
                  ▶ Start
                </button>
              )}
              <button onClick={() => adjustManualClock(-60)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                −1m
              </button>
              <button onClick={() => adjustManualClock(60)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                +1m
              </button>
              <input
                type="number"
                placeholder="Set min"
                className="w-16 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                onBlur={(e) => {
                  if (e.target.value === "") return;
                  const mins = Number(e.target.value);
                  if (!Number.isNaN(mins)) setManualClockSeconds(mins * 60);
                  e.target.value = "";
                }}
              />
            </div>
            <p className="text-[10px] text-white/40">
              Manual stopwatch — a fallback for when OCR can&apos;t read the on-screen timer. Whichever source is
              selected above is what the public page shows.
            </p>
          </div>
        )}
      </div>

      {/* Hero picks/bans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Hero picks & bans</h2>
          <button
            onClick={() =>
              postToTelegram(
                `📋 <b>Draft complete — Game ${game.game_number}</b>\n${match.tournament?.name}\n\n${buildDraftRecap()}`,
                { entityType: "game", entityId: game.id, notificationType: "draft_result" }
              )
            }
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

      {match.update_source !== "local_ocr" && (
        <p className="text-xs text-white/40 border border-white/10 rounded px-3 py-2">
          This is a Normal match — KDA, screenshots, and the moment log aren&apos;t tracked here (Liquipedia-only
          data: picks/bans, score, stream, VOD). Switch to Hot match above to take manual/OCR control.
        </p>
      )}

      {match.update_source === "local_ocr" && (
        <>
      {/* Objectives (counters) */}
      <section className="space-y-3">
        <h2 className="font-bold">Objectives</h2>
        <div className="flex gap-8">
          {[match.team_a, match.team_b].map((team, idx) =>
            team ? (
              <div key={team.id} className="space-y-1.5">
                <p className="text-xs text-white/50">{team.name}</p>
                <div className="flex gap-4">
                  {OBJECTIVE_TYPES.map((type) => (
                    <div key={type} className="flex items-center gap-1.5">
                      <button
                        onClick={() => decrementObjective(team.id, type)}
                        className="w-5 h-5 flex items-center justify-center text-xs border border-white/10 rounded hover:bg-white/10"
                      >
                        −
                      </button>
                      <span className="text-xs w-12 text-center capitalize">
                        {type} <span className="font-bold tabular-nums">{objectiveCount(team.id, type)}</span>
                      </span>
                      <button
                        onClick={() => incrementObjective(team.id, type)}
                        className="w-5 h-5 flex items-center justify-center text-xs border border-white/10 rounded hover:bg-white/10"
                      >
                        +
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <span key={idx} />
            )
          )}
        </div>
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
                </div>
              );
            })}
          </div>
        ))}
      </section>

      {/* Game screenshots */}
      <section className="space-y-3">
        <h2 className="font-bold">Game {game.game_number} screenshots</h2>
        <p className="text-xs text-white/40">
          Captures the shared-screen frame as-is (items, inventory, scoreboard — whatever&apos;s visible), stamped with the
          current in-game timer. Shown publicly at the bottom of this game&apos;s page.
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <button
            onClick={() => captureScreenshotFromPreview()}
            disabled={!captureActive || screenshotUploading}
            className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 disabled:opacity-40"
            title={captureActive ? "Grab the current shared-screen frame" : "Start capture above first"}
          >
            📸 Capture current frame
          </button>
          <label className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 cursor-pointer">
            Upload image...
            <input type="file" accept="image/*" onChange={handleScreenshotFileSelect} className="hidden" disabled={screenshotUploading} />
          </label>
          <input
            value={screenshotNote}
            onChange={(e) => setScreenshotNote(e.target.value)}
            placeholder="Note (optional)"
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs w-40"
          />
          {screenshotUploading && <span className="text-xs text-white/40">Uploading...</span>}
        </div>
        <div className="flex flex-wrap gap-3">
          {screenshots.map((s) => (
            <div key={s.id} className="w-40 space-y-1 lv-card-flush p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.image_url} alt="" className="w-full rounded-md border border-white/10" />
              <div className="flex items-center justify-between text-[10px] text-white/40">
                <span>{s.in_game_time ?? "—"} · {new Date(s.created_at).toLocaleTimeString()}</span>
                <button onClick={() => deleteScreenshot(s.id, s.image_url)} className="text-white/30 hover:text-red-400">✕</button>
              </div>
              {s.note && <p className="text-[10px] text-white/50">{s.note}</p>}
            </div>
          ))}
          {screenshots.length === 0 && <span className="text-white/30 text-xs">No screenshots for this game yet.</span>}
        </div>
      </section>

      {/* Moment list */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Moment list</h2>
          <a href="/admin/moment-templates" className="text-[10px] text-white/40 hover:text-signal">Manage templates ↗</a>
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <select
            value={kmTemplateId}
            onChange={(e) => setKmTemplateId(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm min-w-[220px]"
          >
            <option value="">Choose a template...</option>
            {availableTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.label_template}</option>
            ))}
          </select>
          {selectedTemplate?.label_template.includes("{team}") && (
            <select value={kmTeam} onChange={(e) => setKmTeam(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
              <option value="">Team</option>
              {match.team_a && <option value={match.team_a.id}>{match.team_a.name}</option>}
              {match.team_b && <option value={match.team_b.id}>{match.team_b.name}</option>}
            </select>
          )}
          {selectedTemplate?.label_template.includes("{hero}") && (
            <select value={kmHero} onChange={(e) => setKmHero(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
              <option value="">Hero</option>
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          )}
          {selectedTemplate?.label_template.includes("{player}") && (
            <select value={kmPlayer} onChange={(e) => setKmPlayer(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
              <option value="">Player</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>{p.ign}</option>
              ))}
            </select>
          )}
          {selectedTemplate?.type === "custom" && (
            <input
              value={kmCustomText}
              onChange={(e) => setKmCustomText(e.target.value)}
              placeholder="Type the custom moment..."
              className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm min-w-[220px]"
            />
          )}
          <button onClick={logKeyMoment} disabled={!selectedTemplate} className="lv-btn-ghost disabled:opacity-40">
            Log moment
          </button>
        </div>
        {selectedTemplate && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[10px] text-white/50">
              <input
                type="checkbox"
                checked={kmAttachScreenshot}
                onChange={(e) => setKmAttachScreenshot(e.target.checked)}
                disabled={!captureActive}
              />
              📸 Also grab the current frame into this moment
              {!captureActive && " (start capture above first)"}
            </label>
            {selectedTemplate.type === "custom" && (
              <label className="flex items-center gap-1.5 text-[10px] text-white/50">
                <input type="checkbox" checked={kmMarkAsKey} onChange={(e) => setKmMarkAsKey(e.target.checked)} />
                ⭐ Mark as key moment
              </label>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-xs">
          {keyMoments.map((km) => {
            const player = players.find((p) => p.id === km.player_id);
            const label = km.description ?? `${km.type.replace(/_/g, " ")}${player ? ` — ${player.ign}` : ""}`;
            if (editingMomentId === km.id) {
              return (
                <span key={km.id} className="px-2 py-1 rounded bg-signal/20 flex items-center gap-1.5">
                  <input
                    value={editingMomentText}
                    onChange={(e) => setEditingMomentText(e.target.value)}
                    className="bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-xs w-48"
                    autoFocus
                  />
                  <button onClick={() => updateKeyMoment(km.id, editingMomentText)} className="text-white/60 hover:text-emerald-400 normal-case">✓</button>
                  <button onClick={() => setEditingMomentId(null)} className="text-white/30 hover:text-red-400 normal-case">✕</button>
                </span>
              );
            }
            return (
              <span
                key={km.id}
                className={`px-2 py-1 rounded flex items-center gap-1.5 ${
                  km.is_key_moment ? "bg-signal/30 border border-signal/50 font-semibold" : "bg-white/10"
                }`}
              >
                {km.is_key_moment && "⭐ "}
                {km.minute_mark}&apos; {label}
                {km.screenshot_url && " 📸"}
                <button
                  onClick={() => {
                    setEditingMomentId(km.id);
                    setEditingMomentText(label);
                  }}
                  className="text-white/30 hover:text-white/70 normal-case"
                  title="Edit"
                >
                  ✎
                </button>
                <button
                  onClick={() =>
                    postToTelegram(
                      `🔥 <b>${label}</b>\n${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`,
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
        </>
      )}

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

        {match.update_source === "local_ocr" && (
          <p className="text-xs text-white/50 bg-white/5 border border-white/10 rounded px-3 py-2">
            {PHASE_TRACKER_HINTS[match.state] ?? PHASE_TRACKER_HINTS.CUSTOM}
          </p>
        )}

        {match.update_source === "local_ocr" && match.team_a && match.team_b && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-white/50">Which team is on the left of the broadcast overlay?</label>
            <select
              value={resolveLeftTeamId() ?? ""}
              onChange={(e) => setOcrLeftTeam(e.target.value)}
              className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value={match.team_a.id}>{match.team_a.name}</option>
              <option value={match.team_b.id}>{match.team_b.name}</option>
            </select>
            <span className="text-[10px] text-white/30">
              Set this once per game if sides swap — the "left"/"right" regions below resolve to whichever team this says, no recalibration needed.
            </span>
          </div>
        )}

        {match.update_source !== "local_ocr" ? (
          <p className="text-xs text-white/40">
            This is a Normal match (Liquipedia auto). Click &quot;Normal match&quot; above to make it a Hot match
            and take over with this PC&apos;s screen capture.
          </p>
        ) : (
          <>
            <p className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded px-2 py-1.5">
              Manual region OCR — deterministic, runs entirely in your browser, no AI involved. Full-frame AI
              capture is disabled for now until this manual pipeline is proven out end-to-end; the option
              reappears here once that's done.
            </p>

            {captureMode === "ai" && (
              <div className="flex gap-2 items-center">
                <input
                  value={overlayHint}
                  onChange={(e) => setOverlayHint(e.target.value)}
                  onBlur={saveOverlayHint}
                  placeholder="Overlay hint (optional) — e.g. &quot;kill banners appear top-center in yellow text&quot;"
                  className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                />
                <button
                  onClick={saveOverlayHintAsTournamentDefault}
                  disabled={!overlayHint}
                  className="text-[10px] border border-white/10 rounded px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
                  title="New matches in this tournament will start with this hint already filled in"
                >
                  {overlayHintSavedAsDefault ? "Saved ✓" : "Save as tournament default"}
                </button>
              </div>
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
                    activeCaptureFields.map(({ field }) => {
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

                {captureMode === "manual" && activeCaptureFields.length === 0 && (
                  <p className="text-xs text-white/40 border border-white/10 rounded p-3">
                    {match.state === "DRAFT_COMPLETE"
                      ? "Any picks staged during Draft started are still reviewable above — no crop region needed for this phase."
                      : "Nothing to track in this phase — move to Waiting, Draft started, Game ongoing, Game finished, or Technical pause to calibrate a region."}
                  </p>
                )}

                {captureMode === "manual" && activeCaptureFields.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {activeCaptureFields.map(({ field, label }) => (
                      <div key={field} className="border border-white/10 rounded p-2 space-y-1.5">
                        <p className="text-[10px] text-white/50">{label}</p>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setCalibratingField(field)}
                            className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 flex-1"
                          >
                            {calibratingField === field ? "Drag the area now..." : regions[field] ? "Resize" : "Calibrate"}
                          </button>
                          {regions[field] && (
                            <button
                              onClick={() => clearRegion(field)}
                              title="Clear this region"
                              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        {regions[field] && (
                          <button
                            onClick={() => saveRegionAsTournamentDefault(field)}
                            className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 w-full text-white/50"
                            title="New matches in this tournament will start with this region already calibrated"
                          >
                            {savedDefaultField === field ? "Saved as default ✓" : "Save as tournament default"}
                          </button>
                        )}
                        <p className="text-xs text-white/70 truncate" title={readings[field]}>
                          {readings[field] || "—"}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {match && DRAFT_PHASES.includes(match.state) && stagedDraftActions.length > 0 && (
                  <div className="border border-yellow-500/30 bg-yellow-500/10 rounded p-3 space-y-2 text-xs">
                    <p className="text-yellow-300 font-semibold">
                      {stagedDraftActions.length} draft action{stagedDraftActions.length === 1 ? "" : "s"} detected — review before pushing
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {stagedDraftActions.map((a, i) => (
                        <span key={i} className="lv-badge bg-white/10 text-white/70 capitalize inline-flex items-center gap-1">
                          {a.type} {a.hero_name} ({a.team_name})
                          <button onClick={() => discardStagedDraftAction(i)} className="text-white/30 hover:text-red-400 normal-case">✕</button>
                        </span>
                      ))}
                    </div>
                    <button onClick={pushStagedDraftActions} className="lv-btn-primary !text-xs !py-1.5">
                      Push draft update
                    </button>
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

            {consistencyWarning && (
              <div className="flex flex-wrap items-center gap-3 bg-orange-500/10 border border-orange-500/30 rounded px-4 py-2">
                <span className="text-xs text-orange-300">⚠ {consistencyWarning}</span>
                <button onClick={() => setConsistencyWarning(null)} className="lv-btn-ghost !text-xs !py-1">
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
