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
  status: string;
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
type Player = { id: string; team_id: string; ign: string; role: string | null; photo_url: string | null };
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
  current_time_seconds: number | null;
  current_time_updated_at: string | null;
};
type FinishedGame = { id: string; game_number: number; status: string; map: string | null; winner_team_id: string | null; duration_seconds: number | null };
type PickBan = { id: string; team_id: string; player_id: string | null; hero_name: string; type: "pick" | "ban"; pick_order: number | null };
type PlayerStat = { id: string; player_id: string; hero_name: string | null; kills: number; deaths: number; assists: number; gold: number };
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null; created_at: string };
type NetWorthSnapshot = { minute_mark: number; team_a_gold: number; team_b_gold: number };
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
type MomentTemplate = {
  id: string;
  type: string;
  label_template: string;
  phase: string | null;
  telegram_enabled: boolean;
  telegram_message_template: string | null;
};
type Screenshot = { id: string; image_url: string; in_game_time: string | null; note: string | null; created_at: string };

// The handful of genuinely dramatic moment types that stand out inline in
// the moment list — everything else (phase changes, picks, custom notes)
// still appears in the same feed, just styled as a regular line item.
const KEY_MOMENT_TYPES = ["savage", "maniac", "lord_steal", "turtle_steal", "ace"];

// Same fixed left-to-right draft order used across the admin (Players page
// role dropdown): exp lane, jungler, mid laner, roamer, gold laner —
// confirmed against the real broadcast overlay order, which had roamer
// before gold laner (was previously the other way around).
const ROLE_ORDER = ["Exp Laner", "Jungler", "Mid Laner", "Roamer", "Gold Laner"];
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
  const [netWorth, setNetWorth] = useState<NetWorthSnapshot[]>([]);
  const [minute, setMinute] = useState(0);
  // Companion to `minute` — kept separately rather than changing what
  // `minute` means everywhere, since minute_mark (whole minutes) is still
  // the right grain for most of this file's existing call sites. Only
  // key_moments' new second_mark column needs the sub-minute precision.
  const [secondOfMinute, setSecondOfMinute] = useState(0);
  const mmssTimestamp = () => `${String(minute).padStart(2, "0")}:${String(secondOfMinute).padStart(2, "0")}`;
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select(
        `id, youtube_url, format, current_game_number, status, state, custom_state_label, update_source, series_winner_team_id, tournament_id, ocr_left_team_id,
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
      .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at")
      .eq("match_id", matchId)
      .eq("game_number", m.current_game_number)
      .maybeSingle();

    if (!gameRow) {
      const { data: created, error: createErr } = await supabase
        .from("games")
        .insert({ match_id: matchId, game_number: m.current_game_number, status: "live" })
        .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at")
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
      .select("id, team_id, ign, role, photo_url")
      .in("team_id", teamIds);
    setPlayers((playerRows as Player[]) ?? []);

    if (gameRow) {
      const gid = (gameRow as Game).id;
      const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: ss }, { data: nw }] = await Promise.all([
        supabase.from("hero_picks_bans").select("id, team_id, player_id, hero_name, type, pick_order").eq("game_id", gid).order("pick_order"),
        supabase.from("player_stats").select("id, player_id, hero_name, kills, deaths, assists, gold").eq("game_id", gid),
        supabase.from("objectives").select("id, team_id, type, minute_mark, created_at").eq("game_id", gid).order("minute_mark"),
        supabase.from("key_moments").select("id, type, player_id, team_id, description, minute_mark, is_key_moment, screenshot_url").eq("game_id", gid).order("minute_mark"),
        supabase.from("game_screenshots").select("id, image_url, in_game_time, note, created_at").eq("game_id", gid).order("created_at"),
        supabase.from("net_worth_snapshots").select("minute_mark, team_a_gold, team_b_gold").eq("game_id", gid).order("minute_mark"),
      ]);
      setPickBans((pb as PickBan[]) ?? []);
      setStats((ps as PlayerStat[]) ?? []);
      setObjectives((obj as Objective[]) ?? []);
      setKeyMoments((km as KeyMoment[]) ?? []);
      setScreenshots((ss as Screenshot[]) ?? []);
      setNetWorth((nw as NetWorthSnapshot[]) ?? []);
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
    // Every Telegram post sent while the game is actually ongoing gets the
    // current timestamp appended — not just the one dedicated template.
    const fullMessage = match?.state === "GAME_STARTED" ? `${message}\n⏱ ${mmssTimestamp()}` : message;
    const res = await fetch("/api/telegram/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: fullMessage, ...meta }),
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
  // Shared by both the manual "Hero picks & bans" form and the OCR/AI-vision
  // draft-detection push flow (commitDraftAction below) — every pick/ban,
  // however it got logged, should show up in the Moment list without a
  // separate manual step.
  async function logPickBanMoment(type: "pick" | "ban", teamId: string, heroName: string, playerId?: string | null) {
    if (!game || !match) return;
    const teamName = teamId === match.team_a?.id ? match.team_a?.name : teamId === match.team_b?.id ? match.team_b?.name : "";
    const playerName = playerId ? players.find((p) => p.id === playerId)?.ign : null;
    await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type,
      team_id: teamId,
      player_id: playerId || null,
      description: `${teamName} ${type === "pick" ? "picks" : "bans"} ${heroName}${playerName ? ` — ${playerName}` : ""}`,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "auto",
    });
  }

  async function logPickBan() {
    if (!pbTeam || !pbHero || !game) return;
    if (pbType === "pick" && !pbPlayer) return;
    // Same-team hero uniqueness — two players on one team can't both be
    // running the same hero in the same game.
    if (pbType === "pick") {
      const dupeHero = pickBans.some(
        (pb) => pb.team_id === pbTeam && pb.type === "pick" && pb.hero_name.toLowerCase() === pbHero.toLowerCase()
      );
      if (dupeHero) {
        setError(`${pbHero} is already picked by this team this game.`);
        return;
      }
    }
    const { error } = await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      match_id: matchId,
      team_id: pbTeam,
      player_id: pbType === "pick" ? pbPlayer : null,
      hero_name: pbHero,
      hero_id: heroes.find((h) => h.name === pbHero)?.id ?? null,
      type: pbType,
      pick_order: pickBans.length + 1,
    });
    if (error) {
      setError(error.message);
      return;
    }
    await logPickBanMoment(pbType, pbTeam, pbHero, pbType === "pick" ? pbPlayer : null);
    // A manual pick is the scoreboard's source of truth for that slot —
    // sync it immediately instead of leaving the two to drift until
    // someone edits K/D/A by hand.
    if (pbType === "pick" && pbPlayer) await updateStat(pbPlayer, "hero_name", pbHero);
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
    const payload: Record<string, number | string | null> = { [field]: value };
    if (field === "hero_name") payload.hero_id = matchHeroId(value as string);
    await supabase.from("player_stats").update(payload).eq("id", row.id);
    loadAll();
  }

  // ── Live scoreboard: edit/delete player directly ─────────────────────
  // The roster shown here often surfaces real data-quality problems (a
  // nationality mistakenly imported as a player, a stale/duplicate row) —
  // fixing that shouldn't require leaving this page for /admin/players.
  const [editingScoreboardPlayerId, setEditingScoreboardPlayerId] = useState<string | null>(null);
  const [editingScoreboardIgn, setEditingScoreboardIgn] = useState("");
  // Keyed by team_id — which roster player is selected in that team's
  // "add player" dropdown (for a substitute the scoreboard didn't already
  // pick up automatically).
  const [addPlayerSelect, setAddPlayerSelect] = useState<Record<string, string>>({});
  // Pop-out hero reference — all hero icons/names at a glance for fast
  // pick/ban selection, since scrolling a plain <select> of 130+ heroes by
  // name is slow mid-draft. Draft-phase only per its own purpose.
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  async function saveScoreboardPlayerEdit(playerId: string) {
    if (!editingScoreboardIgn.trim()) return;
    const { error } = await supabase.from("players").update({ ign: editingScoreboardIgn.trim() }).eq("id", playerId);
    if (error) setError(error.message);
    else {
      setEditingScoreboardPlayerId(null);
      loadAll();
    }
  }
  async function deleteScoreboardPlayer(playerId: string, ign: string) {
    if (!confirm(`Delete player "${ign}"? This can't be undone.`)) return;
    const { error } = await supabase.from("players").delete().eq("id", playerId);
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? `Can't delete "${ign}" — still referenced by pick/ban or stat rows in another match.`
          : error.message
      );
      return;
    }
    loadAll();
  }
  function buildLiveScoreboardMessage(): string {
    const lines = [match?.team_a, match?.team_b].map((team) => {
      if (!team) return "";
      const teamStats = stats.filter((s) => players.find((p) => p.id === s.player_id)?.team_id === team.id);
      const rows = teamStats
        .map((s) => `${players.find((p) => p.id === s.player_id)?.ign ?? "?"} (${s.hero_name ?? "?"}): ${s.kills}/${s.deaths}/${s.assists}`)
        .join("\n");
      return rows ? `<b>${team.name}</b>\n${rows}` : "";
    });
    return [`📊 <b>Live scoreboard</b>`, `${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`, ...lines.filter(Boolean)].join("\n\n");
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
  function buildObjectivesMessage(): string {
    const lines = [match?.team_a, match?.team_b].map((team) => {
      if (!team) return "";
      const counts = OBJECTIVE_TYPES.map((type) => `${type}: ${objectiveCount(team.id, type)}`).join(" · ");
      return `<b>${team.name}</b>\n${counts}`;
    });
    return [`🏰 <b>Objectives</b>`, `${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`, ...lines.filter(Boolean)].join("\n\n");
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

  // ── Net worth (OCR-fed, but directly editable) ───────────────────────
  // "Latest" is just the highest minute_mark row for this game — snapshots
  // are ordered ascending by loadAll's query.
  const latestNetWorth = netWorth[netWorth.length - 1] ?? null;
  async function updateNetWorthManual(teamAGold: number, teamBGold: number) {
    if (!game || !match) return;
    await supabase.from("net_worth_snapshots").insert({
      game_id: game.id,
      match_id: matchId,
      minute_mark: minute,
      team_a_gold: teamAGold,
      team_b_gold: teamBGold,
    });
    // Every manual edit gets logged — net worth otherwise only ever moves
    // via silent OCR ticks, so a manual correction should be visible/
    // auditable in the same moment list everything else goes through.
    await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: "custom",
      description: `Net worth manually set — ${match.team_a?.name}: ${teamAGold.toLocaleString()}, ${match.team_b?.name}: ${teamBGold.toLocaleString()}`,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "manual",
    });
    loadAll();
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
      const { data } = await supabase
        .from("moment_templates")
        .select("id, type, label_template, phase, telegram_enabled, telegram_message_template")
        .order("sort_order");
      setMomentTemplates((data as MomentTemplate[]) ?? []);
    })();
  }, []);

  // "phase_notice" rows are Telegram config only (see /admin/moment-templates)
  // — a phase transition, not something the admin picks from this dropdown.
  const availableTemplates = momentTemplates.filter((t) => t.type !== "phase_notice" && (!t.phase || t.phase === match?.state));
  const selectedTemplate = momentTemplates.find((t) => t.id === kmTemplateId) ?? null;

  // Shared {placeholder} substitution for both moment-log and phase-notice
  // Telegram messages — {team}/{hero}/{player} match the moment_templates
  // convention already documented on /admin/moment-templates.
  function fillTelegramTemplate(tpl: string, vars: Record<string, string>) {
    return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v ?? ""), tpl);
  }

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

  function resetKmForm() {
    setKmTeam("");
    setKmHero("");
    setKmPlayer("");
    setKmAttachScreenshot(false);
    setKmCustomText("");
    setKmMarkAsKey(false);
  }

  async function logKeyMoment() {
    if (!game || !selectedTemplate || !match) return;

    // "Team {team} wins the game!" / "wins the match!" describe a real
    // match-affecting event, not just log text — route through the same
    // winner-declare / series-finish logic used elsewhere (which also
    // updates games/matches rows, posts Telegram, and logs its own
    // moment) instead of writing a moment that claims something the
    // match's actual state doesn't reflect.
    if (selectedTemplate.type === "game_finish" && kmTeam) {
      await declareGameWinner(kmTeam);
      resetKmForm();
      return;
    }
    if (selectedTemplate.type === "match_finish" && kmTeam && (kmTeam === match.team_a?.id || kmTeam === match.team_b?.id)) {
      const allGames = [...pastGames, game];
      const winsFor = (id: string) => allGames.filter((g) => g.winner_team_id === id).length;
      const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
      const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
      const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
      const teamWins = kmTeam === match.team_a?.id ? aWins : bWins;
      if (teamWins < required) {
        setError(
          `Can't log "wins the match" yet — ${kmTeam === match.team_a?.id ? match.team_a?.name : match.team_b?.name} only has ${teamWins}/${required} game win(s) for ${match.format ?? "BO3"}.`
        );
        return;
      }
      await finalizeSeriesFinished(kmTeam, aWins, bWins);
      resetKmForm();
      return;
    }

    const teamName = kmTeam === match.team_a?.id ? match.team_a?.name : kmTeam === match.team_b?.id ? match.team_b?.name : "";
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
            .replace("{player}", playerName)
            .replace("{timestamp}", mmssTimestamp());
    // Savage/maniac/etc. are always key moments; a custom entry can be
    // explicitly flagged as one too (e.g. an admin's own big-play call).
    const isKeyMoment = KEY_MOMENT_TYPES.includes(selectedTemplate.type) || (selectedTemplate.type === "custom" && kmMarkAsKey);
    // Savage/Maniac are the two moments worth an automatic screenshot —
    // no reason to make the admin remember to tick the checkbox for
    // exactly the plays viewers most want a picture of.
    const autoScreenshot = selectedTemplate.type === "savage" || selectedTemplate.type === "maniac";

    const screenshotUrl = (kmAttachScreenshot || autoScreenshot) && captureActive ? await uploadMomentScreenshot() : null;

    const { error: insertError } = await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: selectedTemplate.type,
      description,
      player_id: kmPlayer || null,
      team_id: kmTeam || null,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "manual",
      is_key_moment: isKeyMoment,
      screenshot_url: screenshotUrl,
    });
    // Was previously unchecked — a rejected insert (e.g. a template type
    // the key_moments type CHECK constraint didn't allow) failed with no
    // feedback at all, which read as "the moment log button does nothing."
    if (insertError) {
      setError(insertError.message);
      return;
    }
    // Securing Lord/Turtle is also an objective — logging the moment
    // shouldn't require a second trip to the Objectives counters below to
    // make the scoreboard agree with what the moment list just said.
    if ((selectedTemplate.type === "lord_steal" || selectedTemplate.type === "turtle_steal") && kmTeam) {
      await incrementObjective(kmTeam, selectedTemplate.type === "lord_steal" ? "lord" : "turtle");
    }
    // Whether this auto-shares to Telegram is config-driven per template
    // (/admin/moment-templates), not tied to is_key_moment — everything else
    // (picks, bans, phase changes not configured to auto-post) stays manual
    // via the 📢 button per moment.
    if (selectedTemplate.telegram_enabled) {
      const message = selectedTemplate.telegram_message_template
        ? fillTelegramTemplate(selectedTemplate.telegram_message_template, { team: teamName, hero: heroName, player: playerName, timestamp: mmssTimestamp() })
        : `🔥 <b>${description}</b>\n${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`;
      postToTelegram(message, {
        entityType: "key_moment",
        entityId: game.id,
        notificationType: "key_moment_auto",
      });
    }
    resetKmForm();
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
    | "networth_left"
    | "networth_right"
    | "kda_left_1"
    | "kda_left_2"
    | "kda_left_3"
    | "kda_left_4"
    | "kda_left_5"
    | "kda_right_1"
    | "kda_right_2"
    | "kda_right_3"
    | "kda_right_4"
    | "kda_right_5"
    | "kill_banner"
    | "victory_banner"
    | "pause_word";
  // One region per player (5 per side) instead of one region for the whole
  // team block — a team-block region asked OCR to read 5 lines out of one
  // crop in a single pass, where any one player's row being slightly
  // misaligned or a hero icon overlapping text could throw off the whole
  // block. Individually-calibrated per-player regions are more reliable
  // (recognize() on a small single-line crop) at the cost of 5x the
  // calibration effort — same tradeoff already made for objectives_left/
  // right vs. one combined region.
  const KDA_SLOT_LABELS = ROLE_ORDER;
  const CAPTURE_FIELDS: { field: CaptureField; label: string }[] = [
    { field: "countdown", label: "Pre-game countdown" },
    { field: "draft_timer_a", label: "Draft timer — Team A" },
    { field: "draft_timer_b", label: "Draft timer — Team B" },
    { field: "draft_picks_left", label: "Draft picks — left side (player + hero text)" },
    { field: "draft_picks_right", label: "Draft picks — right side (player + hero text)" },
    { field: "game_timer", label: "Game timer" },
    { field: "objectives_left", label: "Objectives — left (tower, lord, turtle)" },
    { field: "objectives_right", label: "Objectives — right (tower, lord, turtle)" },
    { field: "networth_left", label: "Net worth — left" },
    { field: "networth_right", label: "Net worth — right" },
    ...([1, 2, 3, 4, 5] as const).map((n) => ({
      field: `kda_left_${n}` as CaptureField,
      label: `K/D/A — left #${n} (${KDA_SLOT_LABELS[n - 1]})`,
    })),
    ...([1, 2, 3, 4, 5] as const).map((n) => ({
      field: `kda_right_${n}` as CaptureField,
      label: `K/D/A — right #${n} (${KDA_SLOT_LABELS[n - 1]})`,
    })),
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
      "networth_left",
      "networth_right",
      "kda_left_1",
      "kda_left_2",
      "kda_left_3",
      "kda_left_4",
      "kda_left_5",
      "kda_right_1",
      "kda_right_2",
      "kda_right_3",
      "kda_right_4",
      "kda_right_5",
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
    networth_left: null,
    networth_right: null,
    kda_left_1: null,
    kda_left_2: null,
    kda_left_3: null,
    kda_left_4: null,
    kda_left_5: null,
    kda_right_1: null,
    kda_right_2: null,
    kda_right_3: null,
    kda_right_4: null,
    kda_right_5: null,
    kill_banner: null,
    victory_banner: null,
    pause_word: null,
  };
  type RegionBox = { xPct: number; yPct: number; wPct: number; hPct: number };

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Corner-drag resize state for region calibration. dragMode covers a
  // fresh draw, moving the whole box, or one of the 4 corner handles;
  // dragStartPct/dragStartBox snapshot where the drag began so every
  // subsequent mousemove computes a fresh box from the same origin
  // instead of drifting from incremental deltas. Window-level listeners
  // (not container-scoped) so a fast drag that briefly leaves the small
  // preview area doesn't drop the interaction.
  type DragMode = "draw" | "move" | "nw" | "ne" | "sw" | "se";
  const dragMode = useRef<DragMode | null>(null);
  const dragStartPct = useRef<{ x: number; y: number } | null>(null);
  const dragStartBox = useRef<RegionBox | null>(null);
  const cropRectRef = useRef<DOMRect | null>(null);
  // Guards the auto GAME_STARTED transition below so it only fires once
  // per game, not on every OCR tick that finds a readable timer.
  const autoStartedGameId = useRef<string | null>(null);
  // Tracks how long game_timer has failed to parse a valid mm:ss, in real
  // elapsed time rather than a raw tick count — a plain "3 ticks" counter
  // (at the 5s capture interval, 15s total) turned out to fire on brief,
  // ordinary OCR misreads (a kill-cam or overlay transition briefly
  // obscuring the timer), not just an actual pause, since tesseract isn't
  // perfectly reliable frame-to-frame even mid-game. Widened to a real
  // 30s-elapsed threshold instead, which also stays correct if a tick is
  // ever delayed (a strict tick count would under-count real elapsed time
  // in that case). The one case this is reserved for is "tracker went
  // blank" inference (technical pause) — a blank timer alone can't
  // otherwise distinguish a pause from a caster cutaway or the game
  // actually ending (those have their own, better signals: the
  // victory-banner OCR and the deterministic win-count math below).
  const unreadableTimerSince = useRef<number | null>(null);
  const pauseSuggested = useRef(false);
  // Guards against overlapping ticks — GAME_STARTED scans up to 18 regions
  // sequentially (10 of those are the per-player K/D/A slots; vs. 1-4 for
  // every other phase), and each is a real tesseract.js recognize() call.
  // On a slower machine/frame that easily exceeds the 5s interval between
  // ticks; setInterval doesn't wait for its callback to finish, so without
  // this a new tick started reading from the
  // same Tesseract worker while the previous one was still mid-recognize —
  // the worker serializes those internally, so ticks just piled up behind
  // each other forever and the tracker looked stalled/dead once
  // GAME_STARTED's much longer field list was reached.
  const tickInFlight = useRef(false);

  const [captureActive, setCaptureActive] = useState(false);
  const [calibratingField, setCalibratingField] = useState<CaptureField | null>(null);
  // Live-editable draft of the region currently being calibrated — shown
  // with a preview box + corner handles, not persisted to capture_regions
  // until the admin explicitly locks it (see lockDraftBox). Starts from
  // the field's existing saved region when there is one, so "Resize" is a
  // real corner-drag adjustment instead of redrawing from scratch.
  const [draftBox, setDraftBox] = useState<RegionBox | null>(null);
  const [manualTimeInputs, setManualTimeInputs] = useState<Record<string, string>>({});
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
    networth_left: "",
    networth_right: "",
    kda_left_1: "",
    kda_left_2: "",
    kda_left_3: "",
    kda_left_4: "",
    kda_left_5: "",
    kda_right_1: "",
    kda_right_2: "",
    kda_right_3: "",
    kda_right_4: "",
    kda_right_5: "",
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
  const [heroes, setHeroes] = useState<{ id: string; name: string; icon_url: string | null }[]>([]);
  const [overlayHint, setOverlayHint] = useState("");
  const [aiDetection, setAiDetection] = useState<AiDetection | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [suggestedWinner, setSuggestedWinner] = useState<string | null>(null);
  const lastAutoKeyMoment = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("heroes").select("id, name, icon_url").order("name");
      setHeroes((data as { id: string; name: string; icon_url: string | null }[]) ?? []);
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
    await logPickBanMoment(action.type, teamId, action.hero_name);
  }

  async function pushStagedDraftActions() {
    for (const action of stagedDraftActions) await commitDraftAction(action);
    setStagedDraftActions([]);
    loadAll();
  }

  const [retakingDraft, setRetakingDraft] = useState(false);
  // Picks staged mid-draft can go stale by the time the draft actually
  // locks in (a last-second swap, a misread corrected by the caster) —
  // this does one fresh OCR pass over both draft-picks regions and
  // corrects hero_picks_bans per player instead of leaving whatever was
  // captured earlier standing. Only meaningful once DRAFT_COMPLETE, with
  // capture still running so there's a live frame to read.
  async function retakeDraftPicks() {
    const video = previewRef.current;
    const worker = workerRef.current;
    if (!game || !match || !video || !worker) return;
    setRetakingDraft(true);
    try {
      const sides: [CaptureField, () => string | null][] = [
        ["draft_picks_left", resolveLeftTeamId],
        ["draft_picks_right", resolveRightTeamId],
      ];
      for (const [field, getTeamId] of sides) {
        const box = regions[field];
        const teamId = getTeamId();
        if (!box || !teamId) continue;
        const canvas = cropCanvasFor(video, box);
        if (!canvas) continue;
        const { data: { text } } = await worker.recognize(canvas);
        for (const { player, hero } of parseDraftPickLines(text, teamId)) {
          const playerRow = players.find((p) => p.team_id === teamId && p.ign.toLowerCase() === player.toLowerCase());
          if (!playerRow) continue;
          // Replace this player's existing pick (if any) rather than
          // appending — a retake is a correction, not a second pick.
          await supabase.from("hero_picks_bans").delete().eq("game_id", game.id).eq("player_id", playerRow.id).eq("type", "pick");
          await supabase.from("hero_picks_bans").insert({
            game_id: game.id,
            match_id: matchId,
            team_id: teamId,
            player_id: playerRow.id,
            hero_name: hero,
            hero_id: matchHeroId(hero),
            type: "pick",
            pick_order: pickBans.length + 1,
          });
          await logPickBanMoment("pick", teamId, hero, playerRow.id);
          await updateStat(playerRow.id, "hero_name", hero);
        }
      }
    } finally {
      setRetakingDraft(false);
      loadAll();
    }
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
          // source: "ai" was never a valid value — key_moments_source_check
          // only allows 'manual'/'auto', so every AI-vision-detected key
          // moment (Savage/Maniac/etc.) failed this insert silently, every
          // time, since this call's error was never checked either.
          const { error: kmInsertError } = await supabase.from("key_moments").insert({
            game_id: game.id,
            match_id: matchId,
            type: detection.key_moment_banner.toLowerCase(),
            player_id: playerId,
            minute_mark: minute,
            second_mark: secondOfMinute,
            source: "auto",
            confidence: detection.confidence ?? null,
            is_key_moment: KEY_MOMENT_TYPES.includes(detection.key_moment_banner.toLowerCase()),
          });
          if (kmInsertError) console.error("Failed to log AI-detected key moment:", kmInsertError.message);
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

  // Keeps `minute` (used for minute_mark on every logged action) following
  // whichever clock source is active — replaces the old manual number
  // input entirely. captureTick() already calls setMinute() on every OCR
  // read while capture is actively running; this covers the gaps: the
  // manual-stopwatch source at all times, and the OCR source's persisted
  // value (current_time_seconds/_updated_at) for whenever capture isn't
  // actively running (paused, not yet started) so minute doesn't just sit
  // stale at whatever it last was.
  useEffect(() => {
    if (!game) return;
    if (game.clock_source === "manual") {
      const tick = () => {
        const s = manualElapsedSeconds(game);
        setMinute(Math.floor(s / 60));
        setSecondOfMinute(s % 60);
      };
      tick();
      if (!game.manual_time_running) return;
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
    if (captureActive) return; // captureTick() owns it while actively reading
    if (game.current_time_seconds == null || !game.current_time_updated_at) return;
    const elapsed = Math.floor((Date.now() - new Date(game.current_time_updated_at).getTime()) / 1000);
    const totalSeconds = game.current_time_seconds + elapsed;
    setMinute(Math.floor(totalSeconds / 60));
    setSecondOfMinute(totalSeconds % 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    game?.id,
    game?.clock_source,
    game?.manual_time_running,
    game?.manual_time_seconds,
    game?.manual_time_started_at,
    game?.current_time_seconds,
    game?.current_time_updated_at,
    captureActive,
  ]);

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

  // Manual fallback for countdown/draft-timer fields — both are one-way
  // countdowns the public page already decays client-side from a single
  // (value, updated_at) pair, so unlike the game clock these don't need a
  // running/paused state machine, just a way to set the starting value
  // when OCR hasn't been calibrated yet or the overlay text isn't legible.
  function parseMmSs(input: string): number | null {
    const m = input.trim().match(/^(\d{1,3}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  async function setManualCountdown(input: string) {
    const totalSeconds = parseMmSs(input);
    if (totalSeconds == null) return;
    lastPersistedCountdown.current = totalSeconds;
    await supabase
      .from("matches")
      .update({ countdown_seconds: totalSeconds, countdown_updated_at: new Date().toISOString() })
      .eq("id", match?.id);
  }
  async function setManualDraftTimer(side: "a" | "b", input: string) {
    const totalSeconds = parseMmSs(input);
    if (totalSeconds == null || !match) return;
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
  // The draft-picks overlay puts player name and hero name on separate
  // lines (player on top, hero below it) per slot, not both on one line —
  // findPlayerAndHeroInLine per-line-in-isolation never matched anything
  // real against that layout, which is why draft-pick OCR looked
  // completely dead. Still handles a same-line "player — hero" format too
  // in case a different tournament's overlay does put them together.
  function parseDraftPickLines(text: string, teamId: string | null): { player: string; hero: string }[] {
    const results: { player: string; hero: string }[] = [];
    let pendingPlayer: string | null = null;
    for (const rawLine of text.split(/\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const { player, hero } = findPlayerAndHeroInLine(line, teamId);
      if (player && hero) {
        results.push({ player: player.ign, hero: hero.name });
        pendingPlayer = null;
      } else if (player) {
        pendingPlayer = player.ign;
      } else if (hero && pendingPlayer) {
        results.push({ player: pendingPlayer, hero: hero.name });
        pendingPlayer = null;
      }
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
    if (tickInFlight.current) return;
    tickInFlight.current = true;
    try {
      await captureTickBody(video, worker);
    } finally {
      tickInFlight.current = false;
    }
  }

  async function captureTickBody(video: HTMLVideoElement, worker: NonNullable<typeof workerRef.current>) {
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
            unreadableTimerSince.current = null;
            pauseSuggested.current = false;
            setMinute(Number(mmss[1]));
            setSecondOfMinute(Number(mmss[2]));
            updateGameClock(Number(mmss[1]), Number(mmss[2]));
            maybeAutoStartGame();
          } else if (match?.state === "GAME_STARTED") {
            // The one case reserved for "tracker went blank" inference — see
            // the comment on unreadableTimerSince above.
            if (unreadableTimerSince.current === null) unreadableTimerSince.current = Date.now();
            const unreadableForMs = Date.now() - unreadableTimerSince.current;
            if (unreadableForMs >= 30000 && !pauseSuggested.current) {
              pauseSuggested.current = true;
              setSuggestion({ type: "game_pause", raw: "Game timer unreadable for 30+ seconds" });
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
        // One region per player now (not one region for the whole team
        // block) — each field still goes through parseKdaLines since a
        // single-line crop is just the degenerate case of the multi-line
        // parser it already was, but results now accumulate across the 5
        // per-side fields instead of being overwritten by the last one read.
        if (field.startsWith("kda_left_")) kdaLeftParsed = [...kdaLeftParsed, ...parseKdaLines(trimmed, leftTeamId)];
        if (field.startsWith("kda_right_")) kdaRightParsed = [...kdaRightParsed, ...parseKdaLines(trimmed, rightTeamId)];
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

    // Net worth: only worth a snapshot once we actually have both sides.
    // No manual "Snapshot net worth" button anymore — this automatic OCR
    // read (and applyAiDetection's equivalent for the AI-vision path) is
    // the only writer to net_worth_snapshots now.
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

  // captureTick/captureFrameAndAnalyze are plain functions recreated on
  // every render, closing over that render's state — regions, match, game,
  // players, heroes, stagedDraftActions, all of it. A bare
  // setInterval(captureTick, 5000) locks in whatever those values were AT
  // THE MOMENT "Start capture" was clicked and never sees anything
  // calibrated or changed afterward (a region drawn mid-session, a phase
  // transition to Game ongoing, a roster edit) for the rest of that
  // capture session — this is the real reason OCR looked completely dead
  // once the match moved past whatever phase was active when capture
  // started, not an OCR-accuracy problem but a stale-closure one (the
  // classic setInterval-in-React pitfall). Routing the interval through a
  // ref that's refreshed to the latest closure every render fixes it
  // without needing to tear down and recreate the interval on every state
  // change.
  const captureTickRef = useRef(captureTick);
  const captureFrameAndAnalyzeRef = useRef(captureFrameAndAnalyze);
  useEffect(() => {
    captureTickRef.current = captureTick;
    captureFrameAndAnalyzeRef.current = captureFrameAndAnalyze;
  });

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
        intervalRef.current = setInterval(() => captureFrameAndAnalyzeRef.current(), 60000);
      } else {
        workerRef.current = await createWorker("eng");
        intervalRef.current = setInterval(() => captureTickRef.current(), 5000);
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

  function clientToPct(clientX: number, clientY: number, rect: DOMRect) {
    return {
      x: Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100)),
    };
  }

  // Starts a drag: drawing a brand-new box (no draftBox yet), moving the
  // whole box, or resizing from one corner. e.stopPropagation() keeps a
  // handle's own mousedown from also bubbling to the container's
  // "start a fresh draw" handler.
  function startBoxDrag(mode: DragMode, e: React.MouseEvent) {
    if (!calibratingField) return;
    e.stopPropagation();
    const container = e.currentTarget.closest("[data-crop-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    cropRectRef.current = rect;
    dragMode.current = mode;
    dragStartPct.current = clientToPct(e.clientX, e.clientY, rect);
    dragStartBox.current = draftBox;
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const mode = dragMode.current;
      const rect = cropRectRef.current;
      const start = dragStartPct.current;
      if (!mode || !rect || !start) return;
      const pt = clientToPct(e.clientX, e.clientY, rect);

      if (mode === "draw") {
        setDraftBox({
          xPct: Math.min(start.x, pt.x),
          yPct: Math.min(start.y, pt.y),
          wPct: Math.abs(pt.x - start.x),
          hPct: Math.abs(pt.y - start.y),
        });
        return;
      }
      const startBox = dragStartBox.current;
      if (!startBox) return;
      if (mode === "move") {
        const dx = pt.x - start.x;
        const dy = pt.y - start.y;
        setDraftBox({
          ...startBox,
          xPct: Math.min(100 - startBox.wPct, Math.max(0, startBox.xPct + dx)),
          yPct: Math.min(100 - startBox.hPct, Math.max(0, startBox.yPct + dy)),
        });
        return;
      }
      // Corner handles — each recomputed from the box-at-drag-start plus
      // the opposite (anchor) edge, not incremental deltas, so a fast or
      // jittery drag can't accumulate drift.
      const right = startBox.xPct + startBox.wPct;
      const bottom = startBox.yPct + startBox.hPct;
      let { xPct, yPct, wPct, hPct } = startBox;
      const MIN = 1.5; // pct — a region under ~1.5% of the preview isn't usable for OCR anyway
      if (mode.includes("w")) {
        xPct = Math.min(pt.x, right - MIN);
        wPct = right - xPct;
      }
      if (mode.includes("e")) {
        wPct = Math.max(MIN, pt.x - startBox.xPct);
      }
      if (mode.includes("n")) {
        yPct = Math.min(pt.y, bottom - MIN);
        hPct = bottom - yPct;
      }
      if (mode.includes("s")) {
        hPct = Math.max(MIN, pt.y - startBox.yPct);
      }
      setDraftBox({ xPct, yPct, wPct, hPct });
    }
    function onUp() {
      dragMode.current = null;
      dragStartPct.current = null;
      dragStartBox.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function lockDraftBox() {
    if (!calibratingField || !draftBox) return;
    if (draftBox.wPct < 1 || draftBox.hPct < 1) return; // too small to be a real region — ignore
    saveRegion(calibratingField, draftBox);
    setDraftBox(null);
    setCalibratingField(null);
  }
  function cancelDraftBox() {
    setDraftBox(null);
    setCalibratingField(null);
  }
  function startCalibrating(field: CaptureField) {
    setCalibratingField(field);
    setDraftBox(regions[field] ?? null);
  }

  async function confirmSuggestion() {
    if (!suggestion || !game) return;
    await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: suggestion.type,
      minute_mark: minute,
      second_mark: secondOfMinute,
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

    // Every game (and series) result gets its own moment-list entry, not
    // just a Telegram post — the public Moment list is otherwise silent on
    // exactly the two moments viewers care about most.
    if (match.update_source === "local_ocr") {
      const winnerName = teamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "game_finish",
        description: `${winnerName} wins Game ${game.game_number}`,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
        is_key_moment: true,
      });
      if (seriesWinner) {
        const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
        await supabase.from("key_moments").insert({
          game_id: game.id,
          match_id: matchId,
          type: "match_finish",
          description: `${seriesWinnerName} wins the series ${Math.max(aWins, bWins)}–${Math.min(aWins, bWins)}`,
          minute_mark: minute,
          second_mark: secondOfMinute,
          source: "manual",
          is_key_moment: true,
        });
      }
    }

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

  // Closes out the series from already-clinched game results (the phase
  // dropdown's "Series finished" option), as opposed to declareGameWinner
  // which closes out the CURRENT game and only promotes to series-finished
  // as a side effect of that. Shares the same finalize/notify shape so a
  // manual dropdown selection ends up in the same state as the button-
  // driven path — final score set, Telegram sent, status set to finished.
  async function finalizeSeriesFinished(seriesWinner: string, aWins: number, bWins: number) {
    if (!match || !game) return;
    const { error } = await supabase
      .from("matches")
      .update({ status: "finished", state: "SERIES_FINISHED", series_winner_team_id: seriesWinner })
      .eq("id", match.id);
    if (error) {
      setError(error.message);
      return;
    }
    if (match.update_source === "local_ocr") {
      const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "match_finish",
        description: `${seriesWinnerName} wins the series ${Math.max(aWins, bWins)}–${Math.min(aWins, bWins)}`,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
        is_key_moment: true,
      });
      await postToTelegram(
        `🏆 <b>Match finished</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${seriesWinnerName}</b>\n${match.tournament?.name}`,
        { entityType: "match", entityId: match.id, notificationType: "match_finished" }
      );
    }
    loadAll();
  }

  const [forceWinnerPrompt, setForceWinnerPrompt] = useState(false);

  // Single gatekeeper for every phase-dropdown selection — routes
  // Game/Series finished through the same winner-declaration logic the
  // buttons already use instead of letting the dropdown set those states
  // directly with no winner attached, and enforces the technical-pause
  // and series-finished-lock rules below.
  async function handlePhaseChange(newState: string) {
    if (!match || !game) return;
    const currentState = match.state;
    if (currentState === newState) return;

    if (currentState === "SERIES_FINISHED") {
      setError("This match is finished — use Reset if you need to change its phase.");
      return;
    }

    if (newState === "GAME_FINISHED") {
      setForceWinnerPrompt(true);
      return;
    }

    if (newState === "SERIES_FINISHED") {
      const allGames = [...pastGames, game];
      const winsFor = (id: string) => allGames.filter((g) => g.winner_team_id === id).length;
      const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
      const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
      const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
      const seriesWinner = aWins >= required ? match.team_a?.id : bWins >= required ? match.team_b?.id : null;
      if (!seriesWinner) {
        setError(`Series finished can't be set yet — no team has reached ${required} game win(s) for ${match.format ?? "BO3"}.`);
        return;
      }
      await finalizeSeriesFinished(seriesWinner, aWins, bWins);
      return;
    }

    if (newState === "TECHNICAL_PAUSE" && currentState !== "GAME_STARTED") {
      setError("Technical pause can only be triggered from Game ongoing.");
      return;
    }
    if (currentState === "TECHNICAL_PAUSE" && newState !== "GAME_STARTED") {
      setError("Technical pause can only return to Game ongoing.");
      return;
    }

    // Pause/resume the manual stopwatch across a technical pause — the OCR
    // clock needs no equivalent handling, since a genuinely paused game's
    // on-screen timer just stops changing, which OCR reads as-is.
    if (newState === "TECHNICAL_PAUSE" && game.clock_source === "manual" && game.manual_time_running) {
      await pauseManualClock();
    }
    if (currentState === "TECHNICAL_PAUSE" && newState === "GAME_STARTED" && game.clock_source === "manual" && !game.manual_time_running) {
      await startManualClock();
    }

    await setMatchPhase(newState);
  }

  // Direct correction for a game's winner (current or a past one), for
  // fixing a wrong call after the fact — distinct from declareGameWinner,
  // which is for FIRST closing out a game and advances current_game_number/
  // posts Telegram as a new event. This only touches the one games row and
  // silently recomputes the series winner from the corrected results,
  // without re-sending any notifications for what is a correction, not a
  // new result.
  async function correctGameWinner(gameId: string, teamId: string) {
    if (!match) return;
    const { error } = await supabase
      .from("games")
      .update({ winner_team_id: teamId, status: "finished", state: "GAME_FINISHED" })
      .eq("id", gameId);
    if (error) {
      setError(error.message);
      return;
    }
    const allWinners: (string | null)[] = pastGames.map((g) => (g.id === gameId ? teamId : g.winner_team_id));
    if (game) allWinners.push(game.id === gameId ? teamId : game.winner_team_id);
    const winsFor = (id: string) => allWinners.filter((w) => w === id).length;
    const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
    const seriesWinner = aWins >= required ? match.team_a?.id : bWins >= required ? match.team_b?.id : null;
    await supabase
      .from("matches")
      .update({ series_winner_team_id: seriesWinner, state: seriesWinner ? "SERIES_FINISHED" : match.state, status: seriesWinner ? "finished" : match.status })
      .eq("id", match.id);
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
        second_mark: secondOfMinute,
        source: "manual",
      });

      // Hot matches get a handful of phase transitions auto-shared to
      // Telegram — the worker never sees local_ocr matches at all (see the
      // postToTelegram comment above), so nothing else announces these.
      // Which transitions actually post, and with what message, is
      // config-driven via the "phase_notice" rows on /admin/moment-templates
      // instead of hardcoded here — falls back to a sensible default message
      // per phase if a row exists but has no custom template text.
      if (newState !== previousState && game) {
        const noticeTemplate = momentTemplates.find((t) => t.type === "phase_notice" && t.phase === newState);
        const header = `${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`;
        const DEFAULT_PHASE_MESSAGES: Record<string, string> = {
          DRAFT_STARTED: `✏️ <b>Draft started — Game ${game.game_number}</b>\n${header}`,
          DRAFT_COMPLETE: `📋 <b>Draft complete — Game ${game.game_number}</b>\n${header}\n\n${buildDraftRecap()}`,
          GAME_STARTED: `🎮 <b>Game ${game.game_number} ongoing</b>\n${header}`,
        };
        if (noticeTemplate?.telegram_enabled) {
          const message = noticeTemplate.telegram_message_template
            ? fillTelegramTemplate(noticeTemplate.telegram_message_template, {
                team_a: match.team_a?.name ?? "",
                team_b: match.team_b?.name ?? "",
                tournament: match.tournament?.name ?? "",
                timestamp: mmssTimestamp(),
              })
            : DEFAULT_PHASE_MESSAGES[newState];
          if (message) {
            await postToTelegram(message, {
              entityType: newState === "DRAFT_COMPLETE" ? "game" : newState === "GAME_STARTED" ? "game" : "match",
              entityId: newState === "DRAFT_STARTED" ? match.id : game.id,
              notificationType: newState === "DRAFT_STARTED" ? "draft_started" : newState === "DRAFT_COMPLETE" ? "draft_result" : "game_started",
            });
          }
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

  // Editing (result, game result, draft/picks-bans, moment log, OCR) is
  // only allowed once a match is actually live or finished — a scheduled
  // match has nothing real to record yet. The one deliberate exception is
  // the Live Scoreboard's edit/delete-player controls just above, which
  // stay usable even while scheduled so roster mistakes can be fixed
  // before a match goes live.
  const isEditable = match.status !== "scheduled";
  // Phase floors: neither of these made any sense before draft's done
  // (hero picks aren't final) or before the game's actually started
  // (nothing to count yet) — previously clickable in every phase.
  const SCOREBOARD_EDITABLE_PHASES = new Set(["DRAFT_COMPLETE", "GAME_STARTED", "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE", "CUSTOM"]);
  const OBJECTIVES_EDITABLE_PHASES = new Set(["GAME_STARTED", "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE", "CUSTOM"]);
  const scoreboardEditable = isEditable && SCOREBOARD_EDITABLE_PHASES.has(match.state);
  const objectivesEditable = isEditable && OBJECTIVES_EDITABLE_PHASES.has(match.state);

  const embedUrl = youtubeEmbedUrl(match.youtube_url);
  const activeCaptureFields = CAPTURE_FIELDS.filter((f) => (PHASE_CAPTURE_FIELDS[match.state] ?? []).includes(f.field));

  // The starting five for this game = whoever has a logged pick, not the
  // whole roster (which included bench/subs never playing this game —
  // the source of "mistakenly taking other data than players"). Falls
  // back to the full roster, sorted the same way, until picks are logged
  // so the admin has someone to pick from. Also always includes anyone
  // with a player_stats row for this game even without a pick — this is
  // what makes the "add player" button below actually work for a
  // substitute who came in without a hero pick ever being logged for
  // them. Both always sort left-to-right by role: exp lane, jungler, mid
  // laner, gold laner, roamer.
  function activeFive(teamId: string | undefined) {
    if (!teamId) return [];
    const pickedIds = new Set(pickBans.filter((pb) => pb.type === "pick" && pb.team_id === teamId && pb.player_id).map((pb) => pb.player_id));
    const statIds = new Set(stats.map((s) => s.player_id));
    const included = players.filter((p) => p.team_id === teamId && (pickedIds.has(p.id) || statIds.has(p.id)));
    const base = included.length > 0 ? included : players.filter((p) => p.team_id === teamId);
    return [...base].sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
  }
  const teamAPlayers = activeFive(match.team_a?.id);
  const teamBPlayers = activeFive(match.team_b?.id);
  const rosterFor = (teamId: string) => players.filter((p) => p.team_id === teamId);
  // Same derivation the public page already uses — a team kill total is
  // just the sum of that team's player_stats.kills, so it stays correct
  // automatically as K/D/A updates rather than needing its own tracked
  // number. This was previously only shown on the public page, not here.
  const teamAKillsTotal = stats
    .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_a?.id)
    .reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamBKillsTotal = stats
    .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_b?.id)
    .reduce((sum, s) => sum + (s.kills ?? 0), 0);
  async function addScoreboardPlayer(playerId: string) {
    await ensureStatRow(playerId);
    loadAll();
  }

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
            onChange={(e) => handlePhaseChange(e.target.value)}
            title="Manual phase override — useful for technical pauses or anything OCR/Liquipedia sync can't reflect on its own"
            // A semi-transparent bg (bg-white/10) on a <select> only tints
            // the CLOSED control — most browsers still render the opened
            // option list with their default light native chrome regardless
            // of surrounding CSS, which is why this read as a barely-visible
            // white dropdown. A solid dark background plus color-scheme:
            // dark fixes both the closed control and the native popup list.
            style={{ colorScheme: "dark" }}
            className="lv-badge bg-white/10 text-white border border-white/20"
          >
            {MATCH_PHASES.map((s) => (
              <option key={s} value={s} className="bg-ink text-white">{s.replace(/_/g, " ")}</option>
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
          <button
            onClick={resetMatch}
            disabled={!isEditable}
            title={
              isEditable
                ? "Deletes all games, picks/bans, stats, and objectives for this match and reverts it to Match not started"
                : "Not available while the match is scheduled — nothing to reset yet"
            }
            className="text-[10px] border border-red-500/30 text-red-400 rounded px-2 py-0.5 hover:bg-red-500/10 disabled:opacity-40"
          >
            ⟲ Reset match
          </button>
        </div>
        {match.state === "SERIES_FINISHED" && (
          <p className="text-sm text-emerald-400 mt-2">
            Series finished — winner: {match.series_winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
          </p>
        )}
        {forceWinnerPrompt && match.team_a && match.team_b && (
          <div className="mt-3 border border-signal/40 bg-signal/10 rounded p-3 space-y-2">
            <p className="text-sm text-signal font-semibold">Which team won Game {game.game_number}?</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  declareGameWinner(match.team_a!.id);
                  setForceWinnerPrompt(false);
                }}
                className="lv-btn-ghost !px-3 !py-1.5"
              >
                {match.team_a.name}
              </button>
              <button
                onClick={() => {
                  declareGameWinner(match.team_b!.id);
                  setForceWinnerPrompt(false);
                }}
                className="lv-btn-ghost !px-3 !py-1.5"
              >
                {match.team_b.name}
              </button>
              <button onClick={() => setForceWinnerPrompt(false)} className="text-xs text-white/40 hover:text-white/70">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {!isEditable && (
        <p className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded px-3 py-2">
          This match is scheduled — result, game result, draft/picks-bans, moment log, and OCR capture are locked
          until it&apos;s set live (needs a stream link on the Matches page) or marked finished. The roster fixes in
          Live scoreboard above stay available.
        </p>
      )}

      {/* Game history — the per-game results that previously showed nowhere in this console */}
      {pastGames.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold text-sm text-white/60">Previous games</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {pastGames.map((g) => (
              <span key={g.id} className="px-3 py-1.5 rounded bg-white/5 border border-white/10 inline-flex items-center gap-1.5">
                Game {g.game_number}
                {g.map && <span className="text-white/40"> · {g.map}</span>} —{" "}
                <strong>{g.winner_team_id === match.team_a?.id ? match.team_a?.name : g.winner_team_id === match.team_b?.id ? match.team_b?.name : "no winner set"}</strong>
                {/* Correcting a past result after the fact — distinct from
                    declareGameWinner, which is for closing out a game the
                    first time and posts a new Telegram/moment event. */}
                {isEditable && match.team_a && match.team_b && (
                  <span className="flex gap-1 ml-1">
                    {[match.team_a, match.team_b].map((t) =>
                      t.id === g.winner_team_id ? null : (
                        <button
                          key={t.id}
                          onClick={() => correctGameWinner(g.id, t.id)}
                          className="text-white/30 hover:text-signal normal-case"
                          title={`Correct: ${t.name} actually won Game ${g.game_number}`}
                        >
                          → {t.name}
                        </button>
                      )
                    )}
                  </span>
                )}
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
            disabled={!isEditable}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm disabled:opacity-40"
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
              <button onClick={() => declareGameWinner(match.team_a!.id)} disabled={!isEditable} className="lv-btn-ghost !px-3 !py-1.5 disabled:opacity-40">
                {match.team_a.name}
              </button>
            )}
            {match.team_b && (
              <button onClick={() => declareGameWinner(match.team_b!.id)} disabled={!isEditable} className="lv-btn-ghost !px-3 !py-1.5 disabled:opacity-40">
                {match.team_b.name}
              </button>
            )}
          </div>
        )}
        {game.status === "finished" && (
          <div className="flex items-center gap-2">
            <span className="lv-badge bg-emerald-500/15 text-emerald-400">
              Game {game.game_number} winner: {game.winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
            </span>
            {/* Not hard-locked after finished — a wrong call can still be
                corrected via the same direct-update path as past games. */}
            {isEditable && match.team_a && match.team_b && (
              <span className="flex gap-1">
                {[match.team_a, match.team_b].map((t) =>
                  t.id === game.winner_team_id ? null : (
                    <button
                      key={t.id}
                      onClick={() => correctGameWinner(game.id, t.id)}
                      className="text-xs text-white/30 hover:text-signal"
                      title={`Correct: ${t.name} actually won Game ${game.game_number}`}
                    >
                      → {t.name}
                    </button>
                  )
                )}
              </span>
            )}
          </div>
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
            <p className="text-xs text-white/50">
              Current minute mark (used for every log action below): <span className="font-bold text-white text-sm tabular-nums">{minute}&apos;</span>
              {" "}— follows whichever clock source is selected, no manual entry needed.
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
            {/* Only one of these two blocks at a time — previously both
                rendered together regardless of which source was selected,
                so pressing "Start" here always ran the manual stopwatch
                even with "OCR clock" selected above, which read as "OCR
                shows manual seconds instead of the real time." */}
            {game.clock_source === "manual" ? (
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
                  type="text"
                  placeholder="MM:SS"
                  title="Set the clock directly, e.g. 12:30"
                  className="w-16 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                  onBlur={(e) => {
                    if (e.target.value === "") return;
                    const m = e.target.value.trim().match(/^(\d{1,3}):(\d{2})$/);
                    if (m) setManualClockSeconds(Number(m[1]) * 60 + Number(m[2]));
                    e.target.value = "";
                  }}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-lg font-bold tabular-nums w-16">
                  {game.current_time_seconds != null
                    ? `${String(Math.floor(game.current_time_seconds / 60)).padStart(2, "0")}:${String(game.current_time_seconds % 60).padStart(2, "0")}`
                    : "—:—"}
                </span>
                <span className="text-[10px] text-white/40">
                  {readings.game_timer
                    ? `Last OCR read: "${readings.game_timer}"`
                    : "No OCR read yet — calibrate the Game timer region below and start capture."}
                </span>
              </div>
            )}
            <p className="text-[10px] text-white/40">
              {game.clock_source === "manual"
                ? "Manual stopwatch — a fallback for when OCR can't read the on-screen timer."
                : "OCR clock — reads the Game timer region below every tick while capture is running."}
              {" "}Whichever source is selected above is what the public page shows.
            </p>
          </div>
        )}
      </div>

      {/* Hero picks/bans */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Hero picks & bans</h2>
          <div className="flex gap-2">
            {DRAFT_PHASES.includes(match.state) && (
              <button
                onClick={() => setShowHeroPicker(true)}
                className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
              >
                🖼 Hero reference
              </button>
            )}
            {match.state === "DRAFT_COMPLETE" && (
              <button
                onClick={retakeDraftPicks}
                disabled={!captureActive || retakingDraft}
                title={captureActive ? "Re-reads both draft-picks regions and corrects any player's pick to match" : "Start capture first"}
                className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
              >
                {retakingDraft ? "Retaking..." : "🔄 Retake draft picks"}
              </button>
            )}
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
        </div>

        {showHeroPicker && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
            onClick={() => setShowHeroPicker(false)}
          >
            <div
              className="bg-ink border border-white/10 rounded-lg p-4 max-w-3xl w-full max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">Hero reference — click to select</h3>
                <button onClick={() => setShowHeroPicker(false)} className="text-white/40 hover:text-white/70 text-sm">✕</button>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
                {heroes.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setPbHero(h.name);
                      setShowHeroPicker(false);
                    }}
                    className="flex flex-col items-center gap-1 group"
                  >
                    {h.icon_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={h.icon_url}
                        alt=""
                        className="w-12 h-12 rounded-full object-cover border border-white/10 transition-transform duration-150 group-hover:-translate-y-1 group-hover:border-signal"
                      />
                    ) : (
                      <span className="w-12 h-12 rounded-full bg-white/10 transition-transform duration-150 group-hover:-translate-y-1" />
                    )}
                    <span className="text-[10px] text-white/60 group-hover:text-white text-center leading-tight">{h.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
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
                rosterFor(pbTeam)
                  .filter((p) => !pickBans.some((pb) => pb.player_id === p.id && pb.type === "pick"))
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.ign}{p.role ? ` (${p.role})` : ""}</option>
                  ))}
            </select>
          )}
          <div className="flex items-center gap-1.5">
            {heroes.find((h) => h.name === pbHero)?.icon_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={heroes.find((h) => h.name === pbHero)!.icon_url!} alt="" className="w-6 h-6 rounded-full object-cover border border-white/10" />
            )}
            <select
              value={pbHero}
              onChange={(e) => setPbHero(e.target.value)}
              className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
            >
              <option value="">Hero</option>
              {heroes.map((h) => (
                <option key={h.id} value={h.name}>{h.name}</option>
              ))}
            </select>
          </div>
          <button onClick={logPickBan} disabled={!isEditable} className="lv-btn-ghost disabled:opacity-40">
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
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Objectives</h2>
          <button
            onClick={() =>
              postToTelegram(buildObjectivesMessage(), { entityType: "match", entityId: match.id, notificationType: "objectives_share" })
            }
            className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
          >
            📢 Share to Telegram
          </button>
        </div>
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
                        disabled={!objectivesEditable}
                        className="w-5 h-5 flex items-center justify-center text-xs border border-white/10 rounded hover:bg-white/10 disabled:opacity-40"
                      >
                        −
                      </button>
                      <span className="text-xs w-12 text-center capitalize">
                        {type} <span className="font-bold tabular-nums">{objectiveCount(team.id, type)}</span>
                      </span>
                      <button
                        onClick={() => incrementObjective(team.id, type)}
                        disabled={!objectivesEditable}
                        className="w-5 h-5 flex items-center justify-center text-xs border border-white/10 rounded hover:bg-white/10 disabled:opacity-40"
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

      {/* Team kills — derived from K/D/A, same as the public page */}
      <section className="space-y-2">
        <h2 className="font-bold">Team kills</h2>
        <div className="flex gap-6 text-lg font-bold tabular-nums">
          <span className={teamAKillsTotal > teamBKillsTotal ? "text-signal" : "text-white"}>
            {match.team_a?.name}: {teamAKillsTotal}
          </span>
          <span className={teamBKillsTotal > teamAKillsTotal ? "text-signal" : "text-white"}>
            {match.team_b?.name}: {teamBKillsTotal}
          </span>
        </div>
      </section>

      {/* Net worth — OCR-fed each tick, but directly editable too */}
      <section className="space-y-2">
        <h2 className="font-bold">Net worth</h2>
        <div className="flex gap-4 items-end">
          {[
            { team: match.team_a, key: "team_a_gold" as const, other: latestNetWorth?.team_b_gold ?? 0 },
            { team: match.team_b, key: "team_b_gold" as const, other: latestNetWorth?.team_a_gold ?? 0 },
          ].map(({ team, key, other }, idx) =>
            team ? (
              <div key={team.id} className="space-y-1">
                <p className="text-xs text-white/50">{team.name}</p>
                <input
                  type="number"
                  defaultValue={latestNetWorth?.[key] ?? ""}
                  disabled={!isEditable}
                  placeholder="Gold"
                  className="w-28 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm disabled:opacity-40"
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (Number.isNaN(value)) return;
                    if (value === (latestNetWorth?.[key] ?? null)) return;
                    updateNetWorthManual(idx === 0 ? value : other, idx === 0 ? other : value);
                  }}
                />
              </div>
            ) : (
              <span key={idx} />
            )
          )}
        </div>
      </section>

      {/* Scoreboard */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Live scoreboard</h2>
          <button
            onClick={() =>
              postToTelegram(buildLiveScoreboardMessage(), {
                entityType: "match",
                entityId: match.id,
                notificationType: "scoreboard_share",
              })
            }
            className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
          >
            📢 Share to Telegram
          </button>
        </div>
        {[teamAPlayers, teamBPlayers].map((teamPlayers, idx) => (
          <div key={idx} className="space-y-1">
            <p className="text-xs text-white/50">{idx === 0 ? match.team_a?.name : match.team_b?.name}</p>
            <div className="flex gap-2 items-center text-[10px] text-white/40 pl-8">
              <span className="w-24">Player</span>
              <span className="w-24">Hero</span>
              <span className="w-14">K</span>
              <span className="w-14">D</span>
              <span className="w-14">A</span>
            </div>
            {teamPlayers.map((p) => {
              const stat = stats.find((s) => s.player_id === p.id);
              const isEditingRoster = editingScoreboardPlayerId === p.id;
              return (
                <div key={p.id} className="flex gap-2 items-center text-sm">
                  {p.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.photo_url} alt="" className="w-6 h-6 rounded-full object-cover border border-white/10 shrink-0" />
                  ) : (
                    <span className="w-6 h-6 rounded-full bg-white/10 shrink-0" />
                  )}
                  {isEditingRoster ? (
                    <input
                      value={editingScoreboardIgn}
                      onChange={(e) => setEditingScoreboardIgn(e.target.value)}
                      className="w-24 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-xs"
                      autoFocus
                    />
                  ) : (
                    <span className="w-24 truncate">{p.ign}</span>
                  )}
                  {heroes.find((h) => h.name === stat?.hero_name)?.icon_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={heroes.find((h) => h.name === stat?.hero_name)!.icon_url!}
                      alt=""
                      className="w-5 h-5 rounded-full object-cover -mr-1"
                    />
                  )}
                  <select
                    value={stat?.hero_name ?? ""}
                    onChange={(e) => updateStat(p.id, "hero_name", e.target.value)}
                    disabled={!scoreboardEditable}
                    className="w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs disabled:opacity-40"
                  >
                    <option value="">Hero</option>
                    {heroes.map((h) => (
                      <option key={h.id} value={h.name}>{h.name}</option>
                    ))}
                  </select>
                  {(["kills", "deaths", "assists"] as const).map((field) => (
                    <input
                      key={field}
                      type="number"
                      defaultValue={stat?.[field] ?? 0}
                      onBlur={(e) => updateStat(p.id, field, Number(e.target.value))}
                      disabled={!scoreboardEditable}
                      className="w-14 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs disabled:opacity-40"
                    />
                  ))}
                  <div className="flex gap-1.5 ml-auto">
                    {isEditingRoster ? (
                      <>
                        <button onClick={() => saveScoreboardPlayerEdit(p.id)} className="text-white/50 hover:text-emerald-400 text-xs">✓</button>
                        <button onClick={() => setEditingScoreboardPlayerId(null)} className="text-white/30 hover:text-red-400 text-xs">✕</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setEditingScoreboardPlayerId(p.id);
                            setEditingScoreboardIgn(p.ign);
                          }}
                          title="Edit player"
                          className="text-white/30 hover:text-white/70 text-xs"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => deleteScoreboardPlayer(p.id, p.ign)}
                          title="Delete player"
                          className="text-white/30 hover:text-red-400 text-xs"
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {/* For a substitute the scoreboard didn't already pick up
                automatically (no hero pick logged for them this game) —
                adding them here creates their player_stats row, which
                activeFive() above now also treats as "in the game". */}
            {isEditable && (
              <div className="flex items-center gap-2 pl-8 pt-1">
                {(() => {
                  const teamId = idx === 0 ? match.team_a?.id : match.team_b?.id;
                  if (!teamId) return null;
                  const shownIds = new Set(teamPlayers.map((p) => p.id));
                  const available = rosterFor(teamId).filter((p) => !shownIds.has(p.id));
                  if (available.length === 0) return null;
                  return (
                    <>
                      <select
                        value={addPlayerSelect[teamId] ?? ""}
                        onChange={(e) => setAddPlayerSelect((prev) => ({ ...prev, [teamId]: e.target.value }))}
                        className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                      >
                        <option value="">Add player...</option>
                        {available.map((p) => (
                          <option key={p.id} value={p.id}>{p.ign}{p.role ? ` (${p.role})` : ""}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          const playerId = addPlayerSelect[teamId];
                          if (!playerId) return;
                          addScoreboardPlayer(playerId);
                          setAddPlayerSelect((prev) => ({ ...prev, [teamId]: "" }));
                        }}
                        disabled={!addPlayerSelect[teamId]}
                        className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
                      >
                        + Add
                      </button>
                    </>
                  );
                })()}
              </div>
            )}
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
          <button onClick={logKeyMoment} disabled={!selectedTemplate || !isEditable} className="lv-btn-ghost disabled:opacity-40">
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
              disabled={!captureActive && !isEditable}
              title={!isEditable && !captureActive ? "Not available while the match is scheduled" : undefined}
              className={`text-xs rounded px-3 py-1.5 disabled:opacity-40 ${
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

        {/* Nothing else here makes it obvious when a phase has zero
            regions calibrated — OCR just silently reads nothing forever
            in that case, which looked identical to "OCR is broken" from
            the outside. */}
        {match.update_source === "local_ocr" && activeCaptureFields.length > 0 && (
          <p
            className={`text-xs rounded px-3 py-2 border ${
              activeCaptureFields.every((f) => regions[f.field])
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                : "text-yellow-300 border-yellow-500/30 bg-yellow-500/10"
            }`}
          >
            {activeCaptureFields.filter((f) => regions[f.field]).length}/{activeCaptureFields.length} regions calibrated for this phase
            {!activeCaptureFields.every((f) => regions[f.field]) && " — uncalibrated fields read nothing, however OCR-ready the rest looks"}
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
                  data-crop-container
                  // Bigger default (was max-w-md/448px) and genuinely
                  // resizable via the native browser corner-drag handle —
                  // `resize` needs overflow non-visible to work, which
                  // overflow-auto already gives it. All the crop-box math
                  // reads getBoundingClientRect() live at drag time, so a
                  // resized container needs no other code changes.
                  className="relative w-full max-w-3xl min-w-[320px] border border-white/10 rounded resize overflow-auto select-none"
                  onMouseDown={(e) => {
                    // Only starts a brand-new box — once draftBox exists,
                    // dragging happens via its own body/handle mousedown
                    // (startBoxDrag), which stops propagation before this
                    // ever fires.
                    if (captureMode === "manual" && calibratingField && !draftBox) startBoxDrag("draw", e);
                  }}
                >
                  <video ref={previewRef} muted className="w-full block" />
                  {captureMode === "manual" &&
                    activeCaptureFields
                      .filter(({ field }) => field !== calibratingField)
                      .map(({ field, label }) => {
                        const box = regions[field];
                        if (!box) return null;
                        return (
                          // Clickable straight from the video instead of
                          // only via the small "Resize" button in the field
                          // list below — jumps directly into edit mode for
                          // whichever region was clicked.
                          <button
                            key={field}
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              startCalibrating(field);
                            }}
                            title={`Click to edit: ${label}`}
                            className="absolute border-2 border-white/40 hover:border-signal hover:bg-signal/10 cursor-pointer"
                            style={{
                              left: `${box.xPct}%`,
                              top: `${box.yPct}%`,
                              width: `${box.wPct}%`,
                              height: `${box.hPct}%`,
                            }}
                          />
                        );
                      })}
                  {/* The region currently being calibrated — live preview,
                      draggable body (move) and 4 corner handles (resize).
                      Nothing here persists until "Lock" is clicked. */}
                  {captureMode === "manual" && calibratingField && draftBox && (
                    <div
                      className="absolute border-2 border-signal bg-signal/10 cursor-move"
                      style={{
                        left: `${draftBox.xPct}%`,
                        top: `${draftBox.yPct}%`,
                        width: `${draftBox.wPct}%`,
                        height: `${draftBox.hPct}%`,
                      }}
                      onMouseDown={(e) => startBoxDrag("move", e)}
                    >
                      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                        <div
                          key={corner}
                          onMouseDown={(e) => startBoxDrag(corner, e)}
                          // 20x20px hit target centered exactly on the
                          // corner via translate, regardless of box size —
                          // "edge sensitivity" before this was just the
                          // 2px border itself, easy to miss on a small
                          // region. The visible dot inside stays small.
                          className="absolute w-5 h-5 flex items-center justify-center"
                          style={{
                            left: corner.includes("w") ? 0 : "100%",
                            top: corner.includes("n") ? 0 : "100%",
                            transform: "translate(-50%, -50%)",
                            cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                          }}
                        >
                          <span className="w-2.5 h-2.5 bg-signal rounded-full border border-white block" />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Not yet drawn at all — a one-line hint since the empty
                      container gives no other cue to click-drag. */}
                  {captureMode === "manual" && calibratingField && !draftBox && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Click and drag to draw the region</span>
                    </div>
                  )}
                </div>
                {captureMode === "manual" && calibratingField && (
                  <div className="flex gap-2">
                    <button
                      onClick={lockDraftBox}
                      disabled={!draftBox}
                      className="text-xs border border-signal/50 text-signal rounded px-3 py-1.5 hover:bg-signal/10 disabled:opacity-40"
                    >
                      🔒 Lock {CAPTURE_FIELDS.find((f) => f.field === calibratingField)?.label}
                    </button>
                    <button onClick={cancelDraftBox} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
                      Cancel
                    </button>
                  </div>
                )}

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
                            onClick={() => startCalibrating(field)}
                            disabled={calibratingField === field}
                            className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 flex-1 disabled:opacity-40"
                          >
                            {calibratingField === field ? "Adjusting above..." : regions[field] ? "Resize" : "Calibrate"}
                          </button>
                          {regions[field] && (
                            <button
                              onClick={() => {
                                clearRegion(field);
                                if (calibratingField === field) setDraftBox(null);
                              }}
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
                        {(field === "countdown" || field === "draft_timer_a" || field === "draft_timer_b") && (
                          <div className="flex gap-1">
                            <input
                              value={manualTimeInputs[field] ?? ""}
                              onChange={(e) => setManualTimeInputs((prev) => ({ ...prev, [field]: e.target.value }))}
                              placeholder="MM:SS"
                              className="w-16 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[10px]"
                            />
                            <button
                              onClick={() => {
                                const value = manualTimeInputs[field] ?? "";
                                if (field === "countdown") setManualCountdown(value);
                                else setManualDraftTimer(field === "draft_timer_a" ? "a" : "b", value);
                              }}
                              title="Set this directly instead of waiting on OCR — useful if the region isn't calibrated yet or the overlay text isn't readable"
                              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 flex-1"
                            >
                              Set manually
                            </button>
                          </div>
                        )}
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
