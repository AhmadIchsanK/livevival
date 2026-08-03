"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { createWorker } from "tesseract.js";
import { TeamLogo } from "@/components/TeamLogo";

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
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type Player = { id: string; team_id: string; ign: string; role: string | null; photo_url: string | null; is_active_roster: boolean };
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
  team_a_kills_override: number | null;
  team_b_kills_override: number | null;
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
         team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
         team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`
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
      .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at, team_a_kills_override, team_b_kills_override")
      .eq("match_id", matchId)
      .eq("game_number", m.current_game_number)
      .maybeSingle();

    if (!gameRow) {
      const { data: created, error: createErr } = await supabase
        .from("games")
        .insert({ match_id: matchId, game_number: m.current_game_number, status: "live" })
        .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at, team_a_kills_override, team_b_kills_override")
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
      .select("id, team_id, ign, role, photo_url, is_active_roster")
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

  // "All 10 players have a hero decided" — each side's starting five
  // (same deterministic role-ordered slots the draft_hero_pick trackers
  // resolve against) must have a logged pick for this game, regardless of
  // whether that pick came from OCR, AI vision, or a manual edit.
  function draftFullyResolved(): boolean {
    if (!match?.team_a || !match?.team_b) return false;
    for (const teamId of [match.team_a.id, match.team_b.id]) {
      const teamPlayers = players.filter((p) => p.team_id === teamId).sort((a, b) => roleIndex(a.role) - roleIndex(b.role)).slice(0, 5);
      if (teamPlayers.length < 5) return false;
      if (teamPlayers.some((p) => !pickBans.some((pb) => pb.player_id === p.id && pb.type === "pick"))) return false;
    }
    return true;
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

  // declareGameWinner/finalizeSeriesFinished used to post a hardcoded
  // Telegram string for "game_finish"/"match_finish" no matter what an
  // admin configured on /admin/telegram-notifications (unlike the
  // DRAFT_STARTED/DRAFT_COMPLETE/GAME_STARTED phase notices below, which
  // already respect their moment_templates row) — editing that template
  // had zero effect. Same lookup pattern as those phase notices: an
  // existing row's telegram_enabled/telegram_message_template wins, no row
  // at all preserves the old always-on default so existing setups don't
  // suddenly go silent.
  function telegramMessageFor(type: string, defaultMessage: string, vars: Record<string, string>) {
    const tpl = momentTemplates.find((t) => t.type === type && !t.phase);
    if (!tpl) return defaultMessage;
    if (!tpl.telegram_enabled) return null;
    return tpl.telegram_message_template ? fillTelegramTemplate(tpl.telegram_message_template, vars) : defaultMessage;
  }

  // These auto/manual key-moment screenshots get shared around directly
  // (viewers screenshot Savage/Maniac clips constantly) with no indication
  // they came from this broadcast's own capture — stamp a small logo +
  // "Captured with Livevival" credit onto the bottom of the frame before
  // upload. Logo is cached after the first load since every capture reuses it.
  const watermarkLogoRef = useRef<HTMLImageElement | null>(null);
  function loadWatermarkLogo(): Promise<HTMLImageElement | null> {
    if (watermarkLogoRef.current) return Promise.resolve(watermarkLogoRef.current);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        watermarkLogoRef.current = img;
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = "/logo/logo-dark-bg.png";
    });
  }
  async function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const logo = await loadWatermarkLogo();
    const pad = Math.max(12, width * 0.015);
    const logoWidth = logo ? Math.min(width * 0.2, 200) : 0;
    const logoHeight = logo ? logoWidth * (logo.naturalHeight / logo.naturalWidth) : 0;
    const barHeight = Math.max(logoHeight, 22) + pad;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, height - barHeight, width, barHeight);
    if (logo) ctx.drawImage(logo, pad, height - logoHeight - pad / 2, logoWidth, logoHeight);
    ctx.font = `${Math.max(11, Math.round(width * 0.014))}px sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("Captured with Livevival", width - pad, height - barHeight / 2);
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
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(video, 0, 0);
      drawWatermark(ctx, canvas.width, canvas.height).then(() => {
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
      });
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
  //
  // Trackers are no longer a hardcoded TypeScript union — which (phase,
  // category, variable) combinations exist for a given match is now rows in
  // capture_regions (phase/category/field/label + calibrated box), added,
  // edited, and removed from the UI below instead of compiled into the app.
  // `field` stays a stable string key (e.g. "player_kda_left_3",
  // "objective_right_tower") — the OCR dispatch below recovers which side/
  // slot/objective-type a given tracker is for straight from that key
  // (see fieldParts), rather than needing 10 near-identical hardcoded
  // branches per side per slot.
  type TrackerCategory =
    | "countdown"
    | "draft_timer"
    | "draft_hero_pick"
    | "game_timer"
    | "team_kills"
    | "objective"
    | "net_worth"
    | "player_kda"
    | "kill_banner"
    | "victory_banner"
    | "pause_word";
  type Side = "left" | "right";
  type Tracker = { id: string; phase: string; category: TrackerCategory; field: string; label: string };

  const KDA_SLOT_LABELS = ROLE_ORDER;
  const SIDES: { key: Side; label: string }[] = [
    { key: "left", label: "Left" },
    { key: "right", label: "Right" },
  ];

  // Every (phase, category, variable) combination an admin can add for a
  // match — the "Add tracker" control below offers whatever's in this
  // catalog for the selected phase, minus whatever's already added.
  // Draft-finish (DRAFT_COMPLETE) has no tracker of its own: it reads the
  // same per-player draft_hero_pick regions from DRAFT_STARTED (see
  // retakeDraftPicks) rather than needing a second set. Bans stay manual —
  // ban slots show no text on screen, only an icon, so there's nothing for
  // deterministic OCR to read there.
  function catalogForPhase(phase: string): { category: TrackerCategory; field: string; label: string }[] {
    switch (phase) {
      case "MATCH_NOT_STARTED":
        return [{ category: "countdown", field: "countdown", label: "Pre-game countdown" }];
      case "DRAFT_STARTED": {
        const items: { category: TrackerCategory; field: string; label: string }[] = [];
        for (const side of SIDES) items.push({ category: "draft_timer", field: `draft_timer_${side.key}`, label: `Draft timer — ${side.label}` });
        for (const side of SIDES) {
          for (let n = 1; n <= 5; n++) {
            items.push({
              category: "draft_hero_pick",
              field: `draft_hero_pick_${side.key}_${n}`,
              label: `Hero pick — ${side.label} #${n} (${KDA_SLOT_LABELS[n - 1]})`,
            });
          }
        }
        return items;
      }
      case "GAME_STARTED": {
        const items: { category: TrackerCategory; field: string; label: string }[] = [
          { category: "game_timer", field: "game_timer", label: "Game timer" },
          { category: "kill_banner", field: "kill_banner", label: "Kill banner (Savage/Maniac/etc.)" },
        ];
        for (const side of SIDES) items.push({ category: "team_kills", field: `team_kills_${side.key}`, label: `Team kills — ${side.label}` });
        for (const side of SIDES) items.push({ category: "net_worth", field: `net_worth_${side.key}`, label: `Net worth — ${side.label}` });
        for (const side of SIDES) {
          for (const type of OBJECTIVE_TYPES) {
            items.push({ category: "objective", field: `objective_${side.key}_${type}`, label: `Objective — ${side.label} — ${type}` });
          }
        }
        for (const side of SIDES) {
          for (let n = 1; n <= 5; n++) {
            items.push({
              category: "player_kda",
              field: `player_kda_${side.key}_${n}`,
              label: `K/D/A — ${side.label} #${n} (${KDA_SLOT_LABELS[n - 1]})`,
            });
          }
        }
        return items;
      }
      case "GAME_FINISHED":
        return [{ category: "victory_banner", field: "victory_banner", label: "Victory/defeat banner" }];
      case "TECHNICAL_PAUSE":
        return [{ category: "pause_word", field: "pause_word", label: "Pause indicator" }];
      default:
        return [];
    }
  }

  // Pulls side/slot/objective-type back out of a field key built by the
  // catalog above — e.g. "player_kda_left_3" -> { side: "left", slot: 3 }.
  function fieldParts(field: string): { side: Side | null; slot: number | null; objectiveType: string | null } {
    const side: Side | null = field.includes("_left") ? "left" : field.includes("_right") ? "right" : null;
    const slotMatch = field.match(/_(\d)$/);
    const slot = slotMatch ? Number(slotMatch[1]) : null;
    const objectiveType = OBJECTIVE_TYPES.find((t) => field.endsWith(`_${t}`)) ?? null;
    return { side, slot, objectiveType };
  }
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
  // Which state a drag gesture writes into — "draftBox" is the existing
  // pick-tracker-then-draw flow (inline view, and full-screen edit mode);
  // "pendingFsBox" is full-screen's draw-then-pick flow, where a box can
  // exist with no tracker assigned yet. Read by the shared mousemove/mouseup
  // effect below so both flows can share one drag implementation.
  const dragTarget = useRef<"draftBox" | "pendingFsBox">("draftBox");
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
  const [calibratingField, setCalibratingField] = useState<string | null>(null);
  // Live-editable draft of the region currently being calibrated — shown
  // with a preview box + corner handles, not persisted to capture_regions
  // until the admin explicitly locks it (see lockDraftBox). Starts from
  // the field's existing saved region when there is one, so "Resize" is a
  // real corner-drag adjustment instead of redrawing from scratch.
  const [draftBox, setDraftBox] = useState<RegionBox | null>(null);
  const [manualTimeInputs, setManualTimeInputs] = useState<Record<string, string>>({});
  // Trackers this match currently has configured (loaded from
  // capture_regions, tournament defaults layered under match-specific rows —
  // see the load effect below) — replaces the old hardcoded CAPTURE_FIELDS/
  // PHASE_CAPTURE_FIELDS arrays. `regions`/`readings` stay keyed by the same
  // `field` string as before; only what populates them (data instead of a
  // compiled-in list) changed.
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [regions, setRegions] = useState<Record<string, RegionBox | null>>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [suggestion, setSuggestion] = useState<{ type: string; raw: string } | null>(null);
  const [consistencyWarning, setConsistencyWarning] = useState<string | null>(null);

  // ── Full-screen tracker placement ─────────────────────────────────────
  // A second, bigger editor over the SAME capture_regions rows as the
  // small inline calibration view above — not a parallel data model. The
  // inline view's flow is "pick a tracker, then draw its box"; full-screen
  // reverses that ("draw a box, then pick which tracker it's for") since a
  // full viewport makes free-hand placement much easier to see, so it
  // needs its own draft box (pendingFsBox) that can exist with no tracker
  // assigned yet — draftBox/calibratingField stay reserved for "editing a
  // tracker that's already been chosen" (used by both views).
  const [fullscreenPlacementOpen, setFullscreenPlacementOpen] = useState(false);
  const [fsPhaseFilter, setFsPhaseFilter] = useState<string>("");
  const [fsEditMode, setFsEditMode] = useState(false);
  const [pendingFsBox, setPendingFsBox] = useState<RegionBox | null>(null);
  const [fsPickerPhase, setFsPickerPhase] = useState<string>("");
  const [fsPickerField, setFsPickerField] = useState<string>("");
  useEffect(() => {
    if (pendingFsBox && !fsPickerPhase) setFsPickerPhase(fsPhaseFilter || match?.state || "MATCH_NOT_STARTED");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFsBox]);

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

  const DRAFT_PHASES = ["DRAFT_STARTED", "DRAFT_COMPLETE"];

  // ── Draft: manual ban/pick simulation ─────────────────────────────────
  // Replaces OCR/AI-vision draft detection entirely. Bans show no text on
  // screen (only an icon) so deterministic OCR was never reliable there,
  // and hero-pick detection during a fast-moving draft was the single
  // riskiest OCR surface in the console. The admin instead logs each pick
  // and ban by hand from a searchable hero grid, in the exact fixed order
  // a real tournament draft follows — modeled as one flat array of atomic
  // {side, type} actions rather than named "steps" (some of which cover
  // two heroes for the same team back-to-back), since a flat array turns
  // every "double step" into just two consecutive same-side entries with
  // no special-casing anywhere in the advance logic.
  type DraftSide = "blue" | "red";
  type DraftAtomicAction = { side: DraftSide; type: "ban" | "pick" };
  function buildDraftSequence(): DraftAtomicAction[] {
    const seq: DraftAtomicAction[] = [];
    const ban = (side: DraftSide, n = 1) => { for (let i = 0; i < n; i++) seq.push({ side, type: "ban" }); };
    const pick = (side: DraftSide, n = 1) => { for (let i = 0; i < n; i++) seq.push({ side, type: "pick" }); };
    ban("blue"); ban("red"); ban("blue"); ban("red"); ban("blue"); ban("red"); // Ban 1: B1,R1,B2,R2,B3,R3
    pick("blue"); pick("red", 2); pick("blue", 2);                            // Pick 1: Blue P1, Red P1+P2, Blue P2+P3
    ban("red"); ban("blue"); ban("red"); ban("blue");                        // Ban 2: R4,B4,R5,B5
    pick("red"); pick("blue", 2); pick("red", 2);                            // Pick 2: Red P3, Blue P4+P5, Red P4+P5
    return seq; // 12 bans + 10 picks
  }
  const DRAFT_SEQUENCE = buildDraftSequence();

  type DraftSimState = {
    blueTeamId: string;
    redTeamId: string;
    stepIndex: number;
    committed: { teamId: string; type: "ban" | "pick"; heroName: string }[];
  };
  const [draftSim, setDraftSim] = useState<DraftSimState | null>(null);
  const [simHeroSearch, setSimHeroSearch] = useState("");

  // "Ban 2" / "Pick 3" — counts same-side-same-type entries up to and
  // including this step, so the turn banner reads naturally regardless of
  // whether the step before it belonged to the same team or not.
  function draftStepLabel(stepIndex: number): string {
    const step = DRAFT_SEQUENCE[stepIndex];
    const n = DRAFT_SEQUENCE.slice(0, stepIndex + 1).filter((s) => s.side === step.side && s.type === step.type).length;
    return `${step.type === "ban" ? "Ban" : "Pick"} ${n}`;
  }

  async function startDraftSimulation(blueTeamId: string) {
    if (!game || !match?.team_a || !match?.team_b) return;
    const redTeamId = blueTeamId === match.team_a.id ? match.team_b.id : match.team_a.id;
    if (!confirm("Start draft simulation? This clears any existing picks/bans for this game.")) return;
    await supabase.from("hero_picks_bans").delete().eq("game_id", game.id);
    setDraftSim({ blueTeamId, redTeamId, stepIndex: 0, committed: [] });
    setSimHeroSearch("");
    loadAll();
  }
  // Soft — only abandons the in-memory turn tracker. Whatever's already
  // been logged to hero_picks_bans for completed steps stays; "Reset"
  // below is the destructive one that also deletes those rows.
  function stopDraftSimulation() {
    setDraftSim(null);
    setSimHeroSearch("");
  }
  async function resetDraftSimulation() {
    if (!game) return;
    if (!confirm("Reset the draft? This deletes every pick/ban logged so far for this game.")) return;
    await supabase.from("hero_picks_bans").delete().eq("game_id", game.id);
    setDraftSim(null);
    setSimHeroSearch("");
    loadAll();
  }
  async function logSimulationStep(heroName: string) {
    if (!draftSim || !game || !match) return;
    const step = DRAFT_SEQUENCE[draftSim.stepIndex];
    const teamId = step.side === "blue" ? draftSim.blueTeamId : draftSim.redTeamId;
    const { error } = await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      match_id: matchId,
      team_id: teamId,
      player_id: null, // no hero-to-player assignment during the simulation itself
      hero_name: heroName,
      hero_id: heroes.find((h) => h.name === heroName)?.id ?? null,
      type: step.type,
      pick_order: draftSim.committed.length + 1,
    });
    if (error) {
      setError(error.message);
      return;
    }
    await logPickBanMoment(step.type, teamId, heroName, null);
    const nextIndex = draftSim.stepIndex + 1;
    setDraftSim({ ...draftSim, stepIndex: nextIndex, committed: [...draftSim.committed, { teamId, type: step.type, heroName }] });
    setSimHeroSearch("");
    if (nextIndex >= DRAFT_SEQUENCE.length) {
      setDraftSim(null);
      await setMatchPhase("DRAFT_COMPLETE");
    }
    loadAll();
  }

  // Post-simulation, pre-Finish: the simulation logs picks with no player_id
  // (no hero-to-player assignment happens during it), so once it's done the
  // admin assigns each picked hero to whichever roster player is actually
  // playing it — writes straight onto that pick's own row (not a new one)
  // and syncs the Live Scoreboard's hero column the same way a manual pick
  // already does.
  async function assignHeroToPlayer(pickBanId: string, playerId: string, heroName: string) {
    const { error } = await supabase.from("hero_picks_bans").update({ player_id: playerId }).eq("id", pickBanId);
    if (error) {
      setError(error.message);
      return;
    }
    await updateStat(playerId, "hero_name", heroName);
    loadAll();
  }

  async function applyAiDetection(detection: AiDetection) {
    if (!game || !match) return;

    const timerMatch = detection.game_timer_mm_ss?.match(/(\d{1,2}):(\d{2})/);
    if (timerMatch) {
      setMinute(Number(timerMatch[1]));
      updateGameClock(Number(timerMatch[1]), Number(timerMatch[2]));
    }
    if (detection.phase === "IN_GAME") maybeAutoStartGame();

    // Draft is a manual ban/pick simulation now (see draftSim below) — no
    // more OCR/AI-vision draft detection, so detection.draft_actions (still
    // present on the API response, still shown in the raw AI-status debug
    // panel below) is intentionally not applied to hero_picks_bans here.

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
      // saved trackers/regions; one that was calibrated keeps its own.
      // "overlay_hint" is a text-only row (crop-region columns stay null for
      // it, phase 'ANY') reusing this same table/scoping instead of a
      // dedicated one.
      const cols = "id, field, phase, category, label, x_pct, y_pct, w_pct, h_pct, hint_text";
      const [{ data: tournamentDefaults }, { data: matchRegions }] = await Promise.all([
        supabase.from("capture_regions").select(cols).eq("tournament_id", match.tournament_id),
        supabase.from("capture_regions").select(cols).eq("match_id", matchId),
      ]);
      const nextTrackers: Tracker[] = [];
      const nextRegions: Record<string, RegionBox | null> = {};
      for (const r of [...(tournamentDefaults ?? []), ...(matchRegions ?? [])]) {
        if (r.category === "overlay_hint") continue;
        const idx = nextTrackers.findIndex((t) => t.field === r.field);
        const tracker: Tracker = { id: r.id, phase: r.phase, category: r.category as TrackerCategory, field: r.field, label: r.label ?? r.field };
        if (idx === -1) nextTrackers.push(tracker);
        else nextTrackers[idx] = tracker; // match-specific row overrides the tournament default with the same field
        nextRegions[r.field] = r.x_pct != null ? { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct } : null;
      }
      setTrackers(nextTrackers);
      setRegions((prev) => ({ ...prev, ...nextRegions }));
      const tournamentHint = tournamentDefaults?.find((r) => r.category === "overlay_hint")?.hint_text;
      const matchHint = matchRegions?.find((r) => r.category === "overlay_hint")?.hint_text;
      if (matchHint ?? tournamentHint) setOverlayHint(matchHint ?? tournamentHint ?? "");
    })();
  }, [matchId, match?.tournament_id]);

  // Adding a tracker creates the capture_regions row with no coordinates yet
  // (calibration is a separate, explicit step below) — the phase-scoped
  // unique index (match_id, phase, field) is the hard backstop against a
  // duplicate slipping through; a friendly message covers the common case
  // instead of just surfacing the raw constraint-violation error.
  async function addTracker(phase: string, category: TrackerCategory, field: string, label: string) {
    const { data, error } = await supabase
      .from("capture_regions")
      .insert({ match_id: matchId, phase, category, field, label })
      .select("id")
      .single();
    if (error || !data) {
      setError(error?.message.includes("duplicate key") ? `"${label}" is already tracked for this phase.` : error?.message ?? "Failed to add tracker");
      return;
    }
    setTrackers((prev) => [...prev, { id: data.id, phase, category, field, label }]);
    setRegions((prev) => ({ ...prev, [field]: null }));
  }

  async function removeTracker(tracker: Tracker) {
    await supabase.from("capture_regions").delete().eq("id", tracker.id);
    setTrackers((prev) => prev.filter((t) => t.id !== tracker.id));
    setRegions((prev) => {
      const next = { ...prev };
      delete next[tracker.field];
      return next;
    });
    setReadings((prev) => {
      const next = { ...prev };
      delete next[tracker.field];
      return next;
    });
    if (calibratingField === tracker.field) {
      setCalibratingField(null);
      setDraftBox(null);
    }
  }

  const [trackerLabelDrafts, setTrackerLabelDrafts] = useState<Record<string, string>>({});
  async function renameTracker(tracker: Tracker, newLabel: string) {
    const label = newLabel.trim();
    if (!label || label === tracker.label) return;
    await supabase.from("capture_regions").update({ label }).eq("id", tracker.id);
    setTrackers((prev) => prev.map((t) => (t.id === tracker.id ? { ...t, label } : t)));
    setTrackerLabelDrafts((prev) => {
      const next = { ...prev };
      delete next[tracker.id];
      return next;
    });
  }

  // ── Tracker list: add + sortable/searchable/filterable table ─────────
  const [newTrackerPhase, setNewTrackerPhase] = useState<string>(match?.state ?? "MATCH_NOT_STARTED");
  const [newTrackerChoice, setNewTrackerChoice] = useState("");
  const [trackerSearch, setTrackerSearch] = useState("");
  const [trackerPhaseFilter, setTrackerPhaseFilter] = useState("");
  const [trackerCategoryFilter, setTrackerCategoryFilter] = useState("");
  const [trackerSort, setTrackerSort] = useState<{ key: "phase" | "category" | "label" | "calibrated"; dir: 1 | -1 }>({
    key: "phase",
    dir: 1,
  });
  function toggleTrackerSort(key: typeof trackerSort.key) {
    setTrackerSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }
  // Whatever's in the catalog for the selected phase, minus fields already
  // tracked there — the phase-scoped unique index is the hard backstop,
  // this is just so the dropdown doesn't even offer a duplicate.
  const trackerCatalogOptions = catalogForPhase(newTrackerPhase).filter(
    (opt) => !trackers.some((t) => t.phase === newTrackerPhase && t.field === opt.field)
  );
  async function handleAddTracker() {
    const opt = trackerCatalogOptions.find((o) => o.field === newTrackerChoice);
    if (!opt) return;
    await addTracker(newTrackerPhase, opt.category, opt.field, opt.label);
    setNewTrackerChoice("");
  }
  const visibleTrackers = trackers
    .filter((t) => (trackerPhaseFilter ? t.phase === trackerPhaseFilter : true))
    .filter((t) => (trackerCategoryFilter ? t.category === trackerCategoryFilter : true))
    .filter((t) => (trackerSearch ? t.label.toLowerCase().includes(trackerSearch.toLowerCase()) : true))
    .sort((a, b) => {
      const dir = trackerSort.dir;
      if (trackerSort.key === "calibrated") return (Number(!!regions[a.field]) - Number(!!regions[b.field])) * dir;
      return a[trackerSort.key].localeCompare(b[trackerSort.key]) * dir;
    });

  async function saveRegion(field: string, box: RegionBox) {
    setRegions((prev) => ({ ...prev, [field]: box }));
    const tracker = trackers.find((t) => t.field === field);
    if (!tracker) return;
    await supabase
      .from("capture_regions")
      .update({ x_pct: box.xPct, y_pct: box.yPct, w_pct: box.wPct, h_pct: box.hPct })
      .eq("id", tracker.id);
  }
  async function clearRegionCoords(field: string) {
    setRegions((prev) => ({ ...prev, [field]: null }));
    setReadings((prev) => ({ ...prev, [field]: "" }));
    const tracker = trackers.find((t) => t.field === field);
    if (!tracker) return;
    await supabase.from("capture_regions").update({ x_pct: null, y_pct: null, w_pct: null, h_pct: null }).eq("id", tracker.id);
  }

  // Full-screen's draw-then-pick flow needs one round trip, not two —
  // inserting the tracker row WITH its coordinates already set, instead of
  // addTracker() followed by a separate saveRegion() call that would read
  // back from `trackers` state before the just-added row has landed there.
  async function addTrackerWithRegion(phase: string, category: TrackerCategory, field: string, label: string, box: RegionBox) {
    const { data, error } = await supabase
      .from("capture_regions")
      .insert({ match_id: matchId, phase, category, field, label, x_pct: box.xPct, y_pct: box.yPct, w_pct: box.wPct, h_pct: box.hPct })
      .select("id")
      .single();
    if (error || !data) {
      setError(error?.message.includes("duplicate key") ? `"${label}" is already tracked for this phase.` : error?.message ?? "Failed to add tracker");
      return;
    }
    setTrackers((prev) => [...prev, { id: data.id, phase, category, field, label }]);
    setRegions((prev) => ({ ...prev, [field]: box }));
  }

  // Same "already tracked" filter as trackerCatalogOptions, just
  // parameterized by the full-screen picker's own phase pick instead of
  // the inline Add-tracker row's phase state — the two panels are
  // independent UI, same underlying catalog.
  const fsPickerOptions = catalogForPhase(fsPickerPhase).filter(
    (opt) => !trackers.some((t) => t.phase === fsPickerPhase && t.field === opt.field)
  );
  async function savePendingFsBox() {
    if (!pendingFsBox) return;
    const opt = fsPickerOptions.find((o) => o.field === fsPickerField);
    if (!opt) return;
    const existing = trackers.find((t) => t.phase === fsPickerPhase && t.field === opt.field);
    if (existing) await saveRegion(opt.field, pendingFsBox);
    else await addTrackerWithRegion(fsPickerPhase, opt.category, opt.field, opt.label, pendingFsBox);
    setPendingFsBox(null);
    setFsPickerPhase("");
    setFsPickerField("");
  }
  function cancelPendingFsBox() {
    setPendingFsBox(null);
    setFsPickerPhase("");
    setFsPickerField("");
  }

  const [savedDefaultField, setSavedDefaultField] = useState<string | null>(null);
  async function saveRegionAsTournamentDefault(tracker: Tracker) {
    const box = regions[tracker.field];
    if (!box || !match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      {
        tournament_id: match.tournament_id,
        phase: tracker.phase,
        category: tracker.category,
        field: tracker.field,
        label: tracker.label,
        x_pct: box.xPct,
        y_pct: box.yPct,
        w_pct: box.wPct,
        h_pct: box.hPct,
      },
      { onConflict: "tournament_id,phase,field" }
    );
    setSavedDefaultField(tracker.field);
    setTimeout(() => setSavedDefaultField(null), 2000);
  }

  async function saveOverlayHint() {
    if (!matchId) return;
    await supabase.from("capture_regions").upsert(
      { match_id: matchId, phase: "ANY", category: "overlay_hint", field: "overlay_hint", label: "Overlay hint", hint_text: overlayHint || null },
      { onConflict: "match_id,phase,field" }
    );
  }

  const [overlayHintSavedAsDefault, setOverlayHintSavedAsDefault] = useState(false);
  async function saveOverlayHintAsTournamentDefault() {
    if (!match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      { tournament_id: match.tournament_id, phase: "ANY", category: "overlay_hint", field: "overlay_hint", label: "Overlay hint", hint_text: overlayHint || null },
      { onConflict: "tournament_id,phase,field" }
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
    const cropCtx = crop.getContext("2d");
    // Grayscale before Tesseract sees it — broadcast overlays are almost
    // always light text on a dark translucent panel (or vice versa); color
    // noise (team colors bleeding through the panel, chroma compression
    // artifacts) doesn't carry any digit/letter information and Tesseract's
    // own internal binarization does better starting from a flat luminance
    // image than from full color.
    if (cropCtx) cropCtx.filter = "grayscale(1)";
    cropCtx?.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
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

  // Deterministic per-slot player resolution — a draft_hero_pick or
  // player_kda tracker's own (side, slot) already says which roster
  // position it is (same role order KDA_SLOT_LABELS/teamPlayers uses
  // everywhere else), so identity no longer depends on fuzzy-matching a
  // player name out of the OCR text — only the hero name (or K/D/A digits)
  // needs to be legible in that crop.
  function slotPlayer(side: Side, slot: number): Player | null {
    const teamId = side === "left" ? resolveLeftTeamId() : resolveRightTeamId();
    if (!teamId) return null;
    const teamPlayers = players.filter((p) => p.team_id === teamId).sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
    return teamPlayers[slot - 1] ?? null;
  }
  function findHeroInText(text: string) {
    const n = normalize(text);
    return heroes.find((h) => n.includes(normalize(h.name))) ?? null;
  }
  // Broadcast overlays show net worth either as a raw digit count
  // ("23456") or already abbreviated ("23.4K") depending on the
  // tournament — accept both, always resolving to the same raw-gold
  // number for storage (display-side formatting re-abbreviates it, see
  // formatGold below).
  function parseGoldText(text: string): number | null {
    const abbreviated = text.match(/(\d+(?:\.\d+)?)\s*[kK]/);
    if (abbreviated) return Math.round(Number(abbreviated[1]) * 1000);
    const raw = text.match(/\d[\d,]*/);
    return raw ? Number(raw[0].replace(/,/g, "")) : null;
  }
  function formatGold(n: number): string {
    return `${(n / 1000).toFixed(1)}K`;
  }
  // Prefers a slash-separated "K/D/A" (what the request explicitly calls
  // out, and what most broadcast overlays actually show) but still accepts
  // any other single-character separator as a fallback for a tournament
  // whose overlay uses a different glyph between the three numbers.
  function parseKda(text: string): { kills: number; deaths: number; assists: number } | null {
    const slash = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    const loose = slash ?? text.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (!loose) return null;
    return { kills: Number(loose[1]), deaths: Number(loose[2]), assists: Number(loose[3]) };
  }
  async function applySingleObjectiveReading(teamId: string, type: string, text: string) {
    const n = text.match(/\d+/);
    if (!n) return;
    const target = Number(n[0]);
    const current = objectiveCount(teamId, type);
    for (let i = current; i < target; i++) await incrementObjective(teamId, type);
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
    // Only scan the trackers configured for whatever phase the admin has
    // this match set to right now — this is what makes each phase's
    // tracker genuinely distinct instead of always reading the same fields
    // regardless of what's actually on screen.
    const activeTrackers = trackers.filter((t) => t.phase === match?.state);
    const leftTeamId = resolveLeftTeamId();
    const rightTeamId = resolveRightTeamId();
    // Collected across the loop and applied once at the end, since both
    // sides of a paired variable (net worth, K/D/A) need to be read before
    // they can be cross-checked or combined into one write.
    let networthLeft: number | null = null;
    let networthRight: number | null = null;
    const kdaParsed: { playerId: string; heroName: string | null; kills: number; deaths: number; assists: number }[] = [];

    for (const tracker of activeTrackers) {
      const box = regions[tracker.field];
      if (!box) continue;
      const canvas = cropCanvasFor(video, box);
      if (!canvas) continue;
      const { side, slot, objectiveType } = fieldParts(tracker.field);
      const sideTeamId = side === "left" ? leftTeamId : side === "right" ? rightTeamId : null;

      try {
        const { data: { text } } = await worker.recognize(canvas);
        const trimmed = text.trim();
        setReadings((prev) => ({ ...prev, [tracker.field]: trimmed }));
        const mmss = trimmed.match(/(\d{1,2}):(\d{2})/);
        const secondsOnly = trimmed.match(/^(\d{1,3})$/);

        switch (tracker.category) {
          case "kill_banner": {
            const found = OCR_KEYWORDS.find((k) => k.pattern.test(trimmed));
            if (found) setSuggestion({ type: found.type, raw: trimmed });
            break;
          }
          case "game_timer": {
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
            break;
          }
          case "countdown": {
            if (mmss) updateCountdown(Number(mmss[1]), Number(mmss[2]));
            else if (secondsOnly) updateCountdown(0, Number(secondsOnly[1]));
            break;
          }
          case "draft_timer": {
            if (!sideTeamId) break;
            const teamLetter: "a" | "b" | null = sideTeamId === match?.team_a?.id ? "a" : sideTeamId === match?.team_b?.id ? "b" : null;
            if (!teamLetter) break;
            if (mmss) updateDraftTimer(teamLetter, Number(mmss[1]) * 60 + Number(mmss[2]));
            else if (secondsOnly) updateDraftTimer(teamLetter, Number(secondsOnly[1]));
            break;
          }
          case "team_kills": {
            if (!sideTeamId || !game) break;
            const n = trimmed.match(/\d+/);
            if (!n) break;
            const column = sideTeamId === match?.team_a?.id ? "team_a_kills_override" : "team_b_kills_override";
            await supabase.from("games").update({ [column]: Number(n[0]) }).eq("id", game.id);
            break;
          }
          case "objective": {
            if (sideTeamId && objectiveType) await applySingleObjectiveReading(sideTeamId, objectiveType, trimmed);
            break;
          }
          case "net_worth": {
            const gold = parseGoldText(trimmed);
            if (gold == null) break;
            if (side === "left") networthLeft = gold;
            if (side === "right") networthRight = gold;
            break;
          }
          case "player_kda": {
            if (!side || !slot) break;
            const playerRow = slotPlayer(side, slot);
            const kda = parseKda(trimmed);
            if (playerRow && kda) {
              const hero = findHeroInText(trimmed);
              kdaParsed.push({ playerId: playerRow.id, heroName: hero?.name ?? null, ...kda });
            }
            break;
          }
          case "victory_banner": {
            if (/victory|defeat|win/i.test(trimmed)) {
              const teamId = guessWinnerFromText(trimmed);
              if (teamId) setSuggestedWinner(teamId);
            }
            break;
          }
          case "pause_word": {
            if (/pause/i.test(trimmed)) setSuggestion({ type: "game_pause", raw: trimmed });
            break;
          }
        }
      } catch (err) {
        console.error(`OCR error (${tracker.field})`, err);
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
    // that's costlier to have gone live. Identity is deterministic now (the
    // tracker's own slot), so there's no more "same player matched on both
    // sides" class of bug to warn about — only a duplicate hero is still
    // worth flagging (a real data problem: two teams can't have picked the
    // same hero).
    if (game) {
      for (const row of kdaParsed) {
        await supabase.from("player_stats").upsert(
          { game_id: game.id, match_id: matchId, player_id: row.playerId, hero_name: row.heroName, hero_id: matchHeroId(row.heroName), kills: row.kills, deaths: row.deaths, assists: row.assists },
          { onConflict: "game_id,player_id" }
        );
      }
    }

    const heroesSeen = kdaParsed.map((r) => r.heroName).filter((h): h is string => Boolean(h));
    const duplicateHero = heroesSeen.find((h, i) => heroesSeen.indexOf(h) !== i);
    setConsistencyWarning(duplicateHero ? `"${duplicateHero}" read as picked on two different K/D/A trackers — check hero OCR/roster data.` : null);

    if (game && kdaParsed.length > 0) loadAll();
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
  // startCapture() itself (see the comment there). Also re-runs on
  // fullscreenPlacementOpen: toggling full-screen conditionally mounts a
  // DIFFERENT <video> element (inline view vs. the full-screen portal),
  // and srcObject doesn't carry over across that swap — previewRef always
  // points at whichever one is currently mounted, so re-attaching here
  // keeps the live stream showing in whichever view is visible.
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
  }, [captureActive, fullscreenPlacementOpen]);

  useEffect(() => {
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A closed tab, refresh, or typed-in URL while capture is running tears
  // down the screen-share stream and the OCR interval with no way back —
  // the admin has to re-share the screen and, worse, re-calibrate nothing
  // since regions persist, but loses whatever the running session's local
  // state (staged draft actions, in-flight readings) hadn't been saved
  // yet. Browsers only allow a generic native confirmation here (custom
  // text in the dialog was removed from all major browsers years ago for
  // abuse-prevention reasons), but that's still real friction against an
  // accidental close mid-broadcast.
  useEffect(() => {
    if (!captureActive) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [captureActive]);

  useEffect(() => {
    if (!match || !DRAFT_PHASES.includes(match.state)) setDraftSim(null);
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
  // "start a fresh draw" handler. `target` picks which state the drag
  // writes into — defaults to the existing pick-tracker-then-draw flow
  // (draftBox); full-screen's draw-then-pick flow passes "pendingFsBox"
  // instead, since that box exists before any tracker is chosen.
  function startBoxDrag(mode: DragMode, e: React.MouseEvent, target: "draftBox" | "pendingFsBox" = "draftBox") {
    if (target === "draftBox" && !calibratingField) return;
    e.stopPropagation();
    const container = e.currentTarget.closest("[data-crop-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    cropRectRef.current = rect;
    dragMode.current = mode;
    dragTarget.current = target;
    dragStartPct.current = clientToPct(e.clientX, e.clientY, rect);
    dragStartBox.current = target === "pendingFsBox" ? pendingFsBox : draftBox;
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const mode = dragMode.current;
      const rect = cropRectRef.current;
      const start = dragStartPct.current;
      if (!mode || !rect || !start) return;
      const pt = clientToPct(e.clientX, e.clientY, rect);
      const setBox = dragTarget.current === "pendingFsBox" ? setPendingFsBox : setDraftBox;

      if (mode === "draw") {
        setBox({
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
        setBox({
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
      setBox({ xPct, yPct, wPct, hPct });
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
  function startCalibrating(field: string) {
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
      const vars = {
        team_a: match.team_a?.name ?? "",
        team_b: match.team_b?.name ?? "",
        tournament: match.tournament?.name ?? "",
        winner: winnerName ?? "",
        timestamp: mmssTimestamp(),
      };
      const gameMsg = telegramMessageFor(
        "game_finish",
        `🎮 <b>Game ${game.game_number} result</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${winnerName}</b>\n${match.tournament?.name}`,
        vars
      );
      if (gameMsg) await postToTelegram(gameMsg, { entityType: "game", entityId: game.id, notificationType: "game_result" });
      if (seriesWinner) {
        const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
        const matchMsg = telegramMessageFor(
          "match_finish",
          `🏆 <b>Match finished</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${seriesWinnerName}</b>\n${match.tournament?.name}`,
          { ...vars, winner: seriesWinnerName ?? "" }
        );
        if (matchMsg) await postToTelegram(matchMsg, { entityType: "match", entityId: match.id, notificationType: "match_finished" });
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
      const matchMsg = telegramMessageFor(
        "match_finish",
        `🏆 <b>Match finished</b>\n${match.team_a?.name} vs ${match.team_b?.name}\nWinner: <b>${seriesWinnerName}</b>\n${match.tournament?.name}`,
        {
          team_a: match.team_a?.name ?? "",
          team_b: match.team_b?.name ?? "",
          tournament: match.tournament?.name ?? "",
          winner: seriesWinnerName ?? "",
          timestamp: mmssTimestamp(),
        }
      );
      if (matchMsg) await postToTelegram(matchMsg, { entityType: "match", entityId: match.id, notificationType: "match_finished" });
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

    if (newState === "DRAFT_STARTED" && match.team_a && match.team_b) {
      const aActive = players.filter((p) => p.team_id === match.team_a!.id && p.is_active_roster).length;
      const bActive = players.filter((p) => p.team_id === match.team_b!.id && p.is_active_roster).length;
      if (aActive !== 5 || bActive !== 5) {
        setError(`Both teams need exactly 5 active roster players before draft can start (currently ${aActive}/${bActive}).`);
        return;
      }
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

  const [statusSaving, setStatusSaving] = useState(false);
  async function updateMatchStatus(status: "scheduled" | "live" | "finished") {
    if (!match || status === match.status) return;
    if (status === "live" && !match.youtube_url) return;
    setStatusSaving(true);
    const { error } = await supabase.from("matches").update({ status }).eq("id", match.id);
    setStatusSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
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
          TECHNICAL_PAUSE: `⏸️ <b>Technical pause</b>\n${header}`,
          STREAM_ENDED: `📴 <b>Stream ended</b>\n${header}`,
        };
        // Draft-complete specifically must not announce a recap that's
        // still missing picks — a phase transition can happen (manually,
        // or once OCR/AI infers it) before all 10 players actually have a
        // hero resolved, whether that resolution came from OCR auto-detect
        // or a manual edit. The "📢 Announce draft" button stays a manual
        // override with no such gate — clicking it IS the "or manually"
        // case this is meant to allow.
        const blockedByIncompleteDraft = newState === "DRAFT_COMPLETE" && !draftFullyResolved();
        if (noticeTemplate?.telegram_enabled && !blockedByIncompleteDraft) {
          const message = noticeTemplate.telegram_message_template
            ? fillTelegramTemplate(noticeTemplate.telegram_message_template, {
                team_a: match.team_a?.name ?? "",
                team_b: match.team_b?.name ?? "",
                tournament: match.tournament?.name ?? "",
                game: String(game.game_number),
                timestamp: mmssTimestamp(),
              })
            : DEFAULT_PHASE_MESSAGES[newState];
          if (message) {
            await postToTelegram(message, {
              entityType: newState === "DRAFT_COMPLETE" || newState === "GAME_STARTED" ? "game" : "match",
              entityId: newState === "DRAFT_STARTED" ? match.id : game.id,
              notificationType:
                newState === "DRAFT_STARTED" ? "draft_started"
                : newState === "DRAFT_COMPLETE" ? "draft_result"
                : newState === "GAME_STARTED" ? "game_started"
                : newState === "TECHNICAL_PAUSE" ? "technical_pause"
                : "stream_ended",
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

  // Only a genuine load failure (the match/game never came back at all)
  // is worth a full-page message — every other setError() call happens
  // once the console is already up and running (a rejected phase change,
  // a blocked delete, etc.), and previously replaced this entire live
  // page with a bare line of red text, which during an actual broadcast
  // read as "the page just disappeared." Those now show as a dismissible
  // toast instead (rendered near the bottom of this component) without
  // tearing down the console underneath.
  if (!match || !game) return <p className="text-red-400 text-sm">{error ?? "Loading match..."}</p>;

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
  const activeTrackers = trackers.filter((t) => t.phase === match.state);

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
  async function toggleActiveRoster(playerId: string, next: boolean) {
    const { error } = await supabase.from("players").update({ is_active_roster: next }).eq("id", playerId);
    if (error) {
      setError(error.message);
      return;
    }
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, is_active_roster: next } : p)));
  }
  // A direct "team_kills" OCR tracker (see captureTickBody) overrides this
  // once it's read anything — falls back to summing player_stats.kills
  // (the only source before that tracker existed, and still the only
  // source for Normal/Liquipedia-sourced matches).
  const teamAKillsTotal =
    game?.team_a_kills_override ??
    stats.filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_a?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamBKillsTotal =
    game?.team_b_kills_override ??
    stats.filter((s) => players.find((p) => p.id === s.player_id)?.team_id === match.team_b?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0);
  async function addScoreboardPlayer(playerId: string) {
    await ensureStatRow(playerId);
    loadAll();
  }

  return (
    <div className="text-white space-y-8 max-w-6xl">
      <div>
        <h1 className="lv-heading text-lg flex items-center gap-2.5">
          <TeamLogo url={match.team_a?.logo_url} size="sm" />
          {match.team_a?.name} vs {match.team_b?.name}
          <TeamLogo url={match.team_b?.logo_url} size="sm" />
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
          {/* Match status — previously only settable from the admin/matches
              list, so an admin already deep in the live console had to leave
              it to flip status, and everything below stayed locked
              (isEditable) until they did. Same "Live needs a stream link"
              rule as the matches list. */}
          <div className="flex items-center gap-1" title="Match status — controls whether this console is locked (see the notice below the phase row)">
            {(["scheduled", "live", "finished"] as const).map((s) => (
              <button
                key={s}
                onClick={() => updateMatchStatus(s)}
                disabled={statusSaving || match.status === s || (s === "live" && !match.youtube_url)}
                title={s === "live" && !match.youtube_url ? "Add a stream link first — a match can't go live without one" : undefined}
                className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-wide disabled:opacity-40 ${
                  match.status === s
                    ? s === "live"
                      ? "border-signal bg-signal/20 text-signal"
                      : s === "finished"
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                      : "border-white/30 bg-white/10 text-white"
                    : "border-white/10 text-white/40 hover:bg-white/10 hover:text-white/70"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
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
        <p className="lv-alert-warning">
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

        {/* Active roster (main lineup) — editable up through Draft complete
            (not locked the instant the draft starts, per spec). Draft can't
            start unless both teams have exactly 5 checked here; gated in
            handlePhaseChange, not just visually here. */}
        {(match.state === "MATCH_NOT_STARTED" || DRAFT_PHASES.includes(match.state)) && (
          <div className="border border-white/10 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[match.team_a, match.team_b].map((team, idx) => {
              if (!team) return <span key={idx} />;
              const teamRoster = rosterFor(team.id);
              const activeCount = teamRoster.filter((p) => p.is_active_roster).length;
              return (
                <div key={team.id} className="space-y-1.5">
                  <p className="text-xs text-white/50">
                    {team.name} — active roster{" "}
                    <span className={activeCount === 5 ? "text-emerald-400" : "text-yellow-300"}>{activeCount}/5</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {teamRoster.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => toggleActiveRoster(p.id, !p.is_active_roster)}
                        className={`text-[10px] rounded px-2 py-1 border ${
                          p.is_active_roster
                            ? "border-signal/40 bg-signal/10 text-white"
                            : "border-white/10 text-white/40 hover:border-white/30"
                        }`}
                        title={p.is_active_roster ? "Active — click to bench" : "Bench — click to activate"}
                      >
                        {p.is_active_roster ? "✓ " : ""}
                        {p.ign}
                        {p.role ? ` (${p.role})` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Draft ban/pick simulation — replaces OCR/AI hero-pick detection
            entirely. Bans show no on-screen text (only an icon), so this
            was always the riskiest OCR surface; the admin now logs each
            step by hand from a searchable hero grid, in the exact fixed
            order a tournament draft follows. */}
        {DRAFT_PHASES.includes(match.state) && (
          <div className="border border-white/10 rounded-lg p-3 space-y-3">
            {!draftSim ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-white/50">Draft simulation — pick Blue side (first pick, first ban):</span>
                {match.team_a && (
                  <button onClick={() => startDraftSimulation(match.team_a!.id)} className="lv-btn-ghost !text-xs">
                    {match.team_a.name} is Blue
                  </button>
                )}
                {match.team_b && (
                  <button onClick={() => startDraftSimulation(match.team_b!.id)} className="lv-btn-ghost !text-xs">
                    {match.team_b.name} is Blue
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm font-semibold">
                    {DRAFT_SEQUENCE[draftSim.stepIndex].side === "blue"
                      ? draftSim.blueTeamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name
                      : draftSim.redTeamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
                    {" — "}
                    <span className={DRAFT_SEQUENCE[draftSim.stepIndex].type === "ban" ? "text-red-400" : "text-emerald-400"}>
                      {draftStepLabel(draftSim.stepIndex)}
                    </span>
                    <span className="text-white/30 text-xs"> ({draftSim.stepIndex + 1}/{DRAFT_SEQUENCE.length})</span>
                  </p>
                  <div className="flex gap-2">
                    <button onClick={stopDraftSimulation} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                      Stop
                    </button>
                    <button onClick={resetDraftSimulation} className="text-xs border border-red-500/30 text-red-300 rounded px-2 py-1 hover:bg-red-500/10">
                      Reset draft
                    </button>
                  </div>
                </div>
                <input
                  value={simHeroSearch}
                  onChange={(e) => setSimHeroSearch(e.target.value)}
                  placeholder="Search heroes..."
                  className="w-full bg-black/30 border border-white/10 rounded px-3 py-1.5 text-xs"
                />
                <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2 max-h-64 overflow-y-auto">
                  {heroes
                    .filter((h) => h.name.toLowerCase().includes(simHeroSearch.toLowerCase()))
                    .map((h) => {
                      const taken = draftSim.committed.some((c) => c.heroName.toLowerCase() === h.name.toLowerCase());
                      return (
                        <button
                          key={h.id}
                          onClick={() => logSimulationStep(h.name)}
                          disabled={taken}
                          title={h.name}
                          className={`flex flex-col items-center gap-1 group ${taken ? "opacity-30 cursor-not-allowed" : ""}`}
                        >
                          {h.icon_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={h.icon_url}
                              alt=""
                              className={`w-10 h-10 rounded-full object-cover border border-white/10 ${
                                !taken ? "transition-transform duration-150 group-hover:-translate-y-1 group-hover:border-signal" : ""
                              }`}
                            />
                          ) : (
                            <span className="w-10 h-10 rounded-full bg-white/10 block" />
                          )}
                          <span className="text-[9px] text-white/60 group-hover:text-white text-center leading-tight truncate w-full">
                            {h.name}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Player -> hero assignment — post-simulation, pre-Finish. Each
            dropdown only ever lists this team's picks that don't have a
            player yet, so it shrinks as assignments land instead of
            needing its own "already assigned" filter logic. */}
        {match.state === "DRAFT_COMPLETE" &&
          [match.team_a, match.team_b].some(
            (team) => team && pickBans.some((pb) => pb.team_id === team.id && pb.type === "pick" && !pb.player_id)
          ) && (
            <div className="border border-white/10 rounded-lg p-3 space-y-3">
              <p className="text-xs text-white/50">Assign each picked hero to the player actually playing it:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[match.team_a, match.team_b].map((team, idx) => {
                  if (!team) return <span key={idx} />;
                  const unassigned = pickBans.filter((pb) => pb.team_id === team.id && pb.type === "pick" && !pb.player_id);
                  if (unassigned.length === 0) return <span key={team.id} />;
                  const activeRoster = rosterFor(team.id).filter((p) => p.is_active_roster);
                  return (
                    <div key={team.id} className="space-y-2">
                      <p className="text-xs text-white/50">{team.name}</p>
                      {unassigned.map((pb) => {
                        const hero = heroes.find((h) => h.name === pb.hero_name);
                        return (
                          <div key={pb.id} className="flex items-center gap-2">
                            {hero?.icon_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={hero.icon_url} alt="" className="w-6 h-6 rounded-full object-cover border border-white/10" />
                            ) : (
                              <span className="w-6 h-6 rounded-full bg-white/10 block" />
                            )}
                            <span className="text-xs w-24 truncate">{pb.hero_name}</span>
                            <select
                              defaultValue=""
                              onChange={(e) => e.target.value && assignHeroToPlayer(pb.id, e.target.value, pb.hero_name)}
                              className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                            >
                              <option value="">Assign player...</option>
                              {activeRoster
                                .filter((p) => !pickBans.some((other) => other.player_id === p.id && other.type === "pick"))
                                .map((p) => (
                                  <option key={p.id} value={p.id}>{p.ign}{p.role ? ` (${p.role})` : ""}</option>
                                ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
                <div className="flex items-center gap-1.5">
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
                  {latestNetWorth?.[key] != null && <span className="text-xs text-white/40 tabular-nums">{formatGold(latestNetWorth[key])}</span>}
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

      {/* Action errors (rejected phase change, blocked delete, etc.) —
          a dismissible toast, not a page teardown. See the comment above
          the match/game null-check for why this changed. */}
      {error && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-sm bg-red-500/15 border border-red-500/40 rounded px-3 py-2 z-50 flex items-start gap-2">
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-300/60 hover:text-red-300 text-xs shrink-0">✕</button>
        </div>
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
        {match.update_source === "local_ocr" && activeTrackers.length > 0 && (
          <p
            className={`text-xs rounded px-3 py-2 border ${
              activeTrackers.every((t) => regions[t.field])
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                : "text-yellow-300 border-yellow-500/30 bg-yellow-500/10"
            }`}
          >
            {activeTrackers.filter((t) => regions[t.field]).length}/{activeTrackers.length} trackers calibrated for this phase
            {!activeTrackers.every((t) => regions[t.field]) && " — uncalibrated trackers read nothing, however OCR-ready the rest looks"}
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
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-white/40">
                    Any tracker, any phase, is editable from here regardless of the match's current live phase.
                  </span>
                  <button
                    onClick={() => setFullscreenPlacementOpen(true)}
                    className="text-xs border border-white/10 rounded px-3 py-1.5 hover:border-signal/50 hover:bg-signal/10 whitespace-nowrap"
                  >
                    ⛶ Full-screen placement
                  </button>
                </div>
                <div
                  data-crop-container
                  // Fixed at half the viewport width instead of free-drag
                  // resizable — a freely resizable preview meant the exact
                  // pixel dimensions OCR was reading varied session to
                  // session with no consistent baseline to tune region
                  // calibration or Tesseract accuracy against. Half-viewport
                  // is "as big as possible without going fullscreen," which
                  // keeps the rest of the console (moment log, scoreboard)
                  // visible alongside it. All the crop-box math reads
                  // getBoundingClientRect() live at drag time, so a fixed
                  // size needs no other code changes.
                  className="relative w-[50vw] min-w-[480px] max-w-[1400px] border border-white/10 rounded overflow-hidden select-none"
                  onMouseDown={(e) => {
                    // Only starts a brand-new box — once draftBox exists,
                    // dragging happens via its own body/handle mousedown
                    // (startBoxDrag), which stops propagation before this
                    // ever fires.
                    if (captureMode === "manual" && calibratingField && !draftBox) startBoxDrag("draw", e);
                  }}
                >
                  {/* Full-screen mode reuses this SAME <video> element (via a
                      portal) rather than mounting a second one bound to the
                      same MediaStream — two live decodes of one stream risk
                      drifting a frame apart, which would matter since OCR
                      reads from whichever one is actually mounted. Only one
                      of these two conditional branches is ever in the DOM at
                      once, so previewRef always resolves to the visible one
                      (the srcObject-attach effect re-runs on this toggle). */}
                  {!fullscreenPlacementOpen ? (
                    <video ref={previewRef} muted className="w-full block" />
                  ) : (
                    <div className="w-full aspect-video bg-black flex items-center justify-center text-white/30 text-xs">
                      Preview open in full-screen mode
                    </div>
                  )}
                  {captureMode === "manual" &&
                    trackers
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

                {/* Full-screen tracker placement — a bigger editor over the
                    SAME capture_regions rows, not a parallel system. Portals
                    to document.body so it renders above everything else
                    regardless of where this component sits in the tree. */}
                {fullscreenPlacementOpen &&
                  createPortal(
                    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
                      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/10 bg-ink/95">
                        <span className="text-xs text-white/50 uppercase tracking-wider whitespace-nowrap">
                          Full-screen tracker placement
                        </span>
                        <select
                          value={fsPhaseFilter}
                          onChange={(e) => setFsPhaseFilter(e.target.value)}
                          className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                          title="Only show existing regions for this phase, to reduce clutter while placing new ones"
                        >
                          <option value="">All phases</option>
                          {MATCH_PHASES.map((p) => (
                            <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => setFsEditMode((v) => !v)}
                          className={`text-xs border rounded px-2 py-1.5 whitespace-nowrap ${
                            fsEditMode ? "border-signal text-signal bg-signal/10" : "border-white/10 hover:bg-white/10"
                          }`}
                        >
                          {fsEditMode ? "🖊 Edit existing: ON" : "🖊 Edit existing: OFF"}
                        </button>
                        <span className="text-[10px] text-white/40 hidden sm:inline">
                          {fsEditMode ? "Click an existing region to move/resize it." : "Drag on the video to place a new tracker."}
                        </span>
                        <div className="flex-1" />
                        <button
                          onClick={() => {
                            setFullscreenPlacementOpen(false);
                            setPendingFsBox(null);
                            setFsPickerPhase("");
                            setFsPickerField("");
                          }}
                          className="lv-btn-ghost !text-xs"
                        >
                          Exit full-screen ✕
                        </button>
                      </div>

                      <div className="flex-1 flex items-center justify-center overflow-hidden p-6">
                        <div
                          data-crop-container
                          // Shrink-wraps exactly to the video's own rendered
                          // box (inline-flex + the video's own max-w/max-h +
                          // auto sizing below) instead of a full-viewport box
                          // the video is stretched/letterboxed inside — this
                          // is what makes a percentage saved here land in the
                          // exact same spot in the small inline view: both
                          // views' data-crop-container element IS the
                          // video's content box, never a larger box with
                          // transparent bars baked in, so there's no
                          // separate letterbox offset to compute or drift
                          // between the two.
                          style={{ display: "inline-flex", position: "relative", maxWidth: "100%", maxHeight: "100%" }}
                          onMouseDown={(e) => {
                            if (fsEditMode) return; // existing-region buttons below handle their own click-to-edit
                            if (calibratingField) {
                              if (!draftBox) startBoxDrag("draw", e, "draftBox");
                            } else if (!pendingFsBox) {
                              startBoxDrag("draw", e, "pendingFsBox");
                            }
                          }}
                        >
                          <video
                            ref={previewRef}
                            muted
                            style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", display: "block" }}
                          />

                          {/* Existing regions for the filtered phase — inert
                              dim reference outlines while placing new ones
                              (fsEditMode off), or clickable/draggable exactly
                              like the inline view's overlays once on. */}
                          {trackers
                            .filter((t) => (fsPhaseFilter ? t.phase === fsPhaseFilter : true))
                            .filter(({ field }) => field !== calibratingField)
                            .map(({ field, label }) => {
                              const box = regions[field];
                              if (!box) return null;
                              if (!fsEditMode) {
                                return (
                                  <div
                                    key={field}
                                    className="absolute border border-white/25 pointer-events-none"
                                    style={{ left: `${box.xPct}%`, top: `${box.yPct}%`, width: `${box.wPct}%`, height: `${box.hPct}%` }}
                                  />
                                );
                              }
                              return (
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
                                  style={{ left: `${box.xPct}%`, top: `${box.yPct}%`, width: `${box.wPct}%`, height: `${box.hPct}%` }}
                                />
                              );
                            })}

                          {/* Editing an existing tracker — same move/resize
                              handles as the inline view. */}
                          {calibratingField && draftBox && (
                            <div
                              className="absolute border-2 border-signal bg-signal/10 cursor-move"
                              style={{
                                left: `${draftBox.xPct}%`,
                                top: `${draftBox.yPct}%`,
                                width: `${draftBox.wPct}%`,
                                height: `${draftBox.hPct}%`,
                              }}
                              onMouseDown={(e) => startBoxDrag("move", e, "draftBox")}
                            >
                              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                                <div
                                  key={corner}
                                  onMouseDown={(e) => startBoxDrag(corner, e, "draftBox")}
                                  className="absolute w-6 h-6 flex items-center justify-center"
                                  style={{
                                    left: corner.includes("w") ? 0 : "100%",
                                    top: corner.includes("n") ? 0 : "100%",
                                    transform: "translate(-50%, -50%)",
                                    cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                                  }}
                                >
                                  <span className="w-3 h-3 bg-signal rounded-full border border-white block" />
                                </div>
                              ))}
                            </div>
                          )}

                          {/* A brand-new box, drawn but not yet assigned to a
                              tracker — full-screen's draw-then-pick flow. */}
                          {pendingFsBox && (
                            <div
                              className="absolute border-2 border-signal bg-signal/10 cursor-move"
                              style={{
                                left: `${pendingFsBox.xPct}%`,
                                top: `${pendingFsBox.yPct}%`,
                                width: `${pendingFsBox.wPct}%`,
                                height: `${pendingFsBox.hPct}%`,
                              }}
                              onMouseDown={(e) => startBoxDrag("move", e, "pendingFsBox")}
                            >
                              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                                <div
                                  key={corner}
                                  onMouseDown={(e) => startBoxDrag(corner, e, "pendingFsBox")}
                                  className="absolute w-6 h-6 flex items-center justify-center"
                                  style={{
                                    left: corner.includes("w") ? 0 : "100%",
                                    top: corner.includes("n") ? 0 : "100%",
                                    transform: "translate(-50%, -50%)",
                                    cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                                  }}
                                >
                                  <span className="w-3 h-3 bg-signal rounded-full border border-white block" />
                                </div>
                              ))}
                            </div>
                          )}

                          {calibratingField && !draftBox && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Click and drag to draw the region</span>
                            </div>
                          )}
                          {!calibratingField && !pendingFsBox && !fsEditMode && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Click and drag to place a new tracker</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {calibratingField && (
                        <div className="flex gap-2 justify-center px-4 py-3 border-t border-white/10 bg-ink/95">
                          <button
                            onClick={lockDraftBox}
                            disabled={!draftBox}
                            className="text-xs border border-signal/50 text-signal rounded px-3 py-1.5 hover:bg-signal/10 disabled:opacity-40"
                          >
                            🔒 Lock {trackers.find((t) => t.field === calibratingField)?.label}
                          </button>
                          <button onClick={cancelDraftBox} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
                            Cancel
                          </button>
                        </div>
                      )}

                      {pendingFsBox && (
                        <div className="flex flex-wrap items-center gap-2 justify-center px-4 py-3 border-t border-white/10 bg-ink/95">
                          <select
                            value={fsPickerPhase}
                            onChange={(e) => {
                              setFsPickerPhase(e.target.value);
                              setFsPickerField("");
                            }}
                            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                          >
                            {MATCH_PHASES.map((p) => (
                              <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                            ))}
                          </select>
                          <select
                            value={fsPickerField}
                            onChange={(e) => setFsPickerField(e.target.value)}
                            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs min-w-[220px]"
                          >
                            <option value="">
                              {fsPickerOptions.length === 0 ? "Nothing left to track in this phase" : "Select a variable to track..."}
                            </option>
                            {fsPickerOptions.map((opt) => (
                              <option key={opt.field} value={opt.field}>{opt.label}</option>
                            ))}
                          </select>
                          <button
                            onClick={savePendingFsBox}
                            disabled={!fsPickerField}
                            className="lv-btn-primary !px-3 !py-1.5 disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button onClick={cancelPendingFsBox} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>,
                    document.body
                  )}

                {captureMode === "manual" && calibratingField && (
                  <div className="flex gap-2">
                    <button
                      onClick={lockDraftBox}
                      disabled={!draftBox}
                      className="text-xs border border-signal/50 text-signal rounded px-3 py-1.5 hover:bg-signal/10 disabled:opacity-40"
                    >
                      🔒 Lock {trackers.find((t) => t.field === calibratingField)?.label}
                    </button>
                    <button onClick={cancelDraftBox} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
                      Cancel
                    </button>
                  </div>
                )}

                {captureMode === "manual" && (
                  <div className="space-y-3">
                    {/* Add tracker — categorized by phase, catalog already
                        excludes whatever's tracked for that phase; the
                        phase-scoped DB unique index is the hard backstop. */}
                    <div className="border border-white/10 rounded p-2 flex flex-wrap gap-2 items-center">
                      <select
                        value={newTrackerPhase}
                        onChange={(e) => {
                          setNewTrackerPhase(e.target.value);
                          setNewTrackerChoice("");
                        }}
                        className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                      >
                        {MATCH_PHASES.map((p) => (
                          <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                      <select
                        value={newTrackerChoice}
                        onChange={(e) => setNewTrackerChoice(e.target.value)}
                        className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs flex-1 min-w-[220px]"
                      >
                        <option value="">
                          {catalogForPhase(newTrackerPhase).length === 0
                            ? "Nothing to track in this phase"
                            : trackerCatalogOptions.length === 0
                            ? "Everything available is already tracked for this phase"
                            : "Select a variable to track..."}
                        </option>
                        {trackerCatalogOptions.map((opt) => (
                          <option key={opt.field} value={opt.field}>{opt.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleAddTracker}
                        disabled={!newTrackerChoice}
                        className="lv-btn-primary !px-3 !py-1.5 disabled:opacity-40"
                      >
                        + Add tracker
                      </button>
                    </div>

                    {trackers.length === 0 ? (
                      <p className="text-xs text-white/40 border border-white/10 rounded p-3">
                        No trackers configured yet for this match — add one above for whichever phase you want to start with.
                      </p>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-2 items-center">
                          <input
                            value={trackerSearch}
                            onChange={(e) => setTrackerSearch(e.target.value)}
                            placeholder="Search trackers..."
                            className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs flex-1 min-w-[160px]"
                          />
                          <select
                            value={trackerPhaseFilter}
                            onChange={(e) => setTrackerPhaseFilter(e.target.value)}
                            className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                          >
                            <option value="">All phases</option>
                            {MATCH_PHASES.map((p) => (
                              <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                            ))}
                          </select>
                          <select
                            value={trackerCategoryFilter}
                            onChange={(e) => setTrackerCategoryFilter(e.target.value)}
                            className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                          >
                            <option value="">All categories</option>
                            {Array.from(new Set(trackers.map((t) => t.category))).map((c) => (
                              <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                            ))}
                          </select>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="text-white/40 text-left border-b border-white/10">
                                {(["phase", "category", "label", "calibrated"] as const).map((key) => (
                                  <th key={key} className="py-1 pr-2 font-normal cursor-pointer select-none whitespace-nowrap" onClick={() => toggleTrackerSort(key)}>
                                    {key === "calibrated" ? "Status" : key} {trackerSort.key === key ? (trackerSort.dir === 1 ? "▲" : "▼") : ""}
                                  </th>
                                ))}
                                <th className="py-1 pr-2 font-normal">Reading</th>
                                <th className="py-1 font-normal">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleTrackers.map((t) => {
                                const calibrated = !!regions[t.field];
                                const isCountdownLike = t.category === "countdown" || t.category === "draft_timer";
                                return (
                                  <tr key={t.id} className={`border-b border-white/5 ${t.phase === match.state ? "" : "opacity-50"}`}>
                                    <td className="py-1.5 pr-2 whitespace-nowrap">{t.phase.replace(/_/g, " ")}</td>
                                    <td className="py-1.5 pr-2 whitespace-nowrap capitalize">{t.category.replace(/_/g, " ")}</td>
                                    <td className="py-1.5 pr-2 min-w-[160px]">
                                      {trackerLabelDrafts[t.id] != null ? (
                                        <div className="flex gap-1">
                                          <input
                                            autoFocus
                                            value={trackerLabelDrafts[t.id]}
                                            onChange={(e) => setTrackerLabelDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") renameTracker(t, trackerLabelDrafts[t.id]);
                                            }}
                                            className="bg-black/30 border border-signal/40 rounded px-1.5 py-0.5 text-xs w-full"
                                          />
                                          <button onClick={() => renameTracker(t, trackerLabelDrafts[t.id])} className="text-emerald-400">✓</button>
                                        </div>
                                      ) : (
                                        <button onClick={() => setTrackerLabelDrafts((prev) => ({ ...prev, [t.id]: t.label }))} className="text-left hover:text-signal" title="Click to rename">
                                          {t.label}
                                        </button>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-2 whitespace-nowrap">
                                      <span className={calibrated ? "text-emerald-400" : "text-yellow-300"}>{calibrated ? "Calibrated" : "Not calibrated"}</span>
                                    </td>
                                    <td className="py-1.5 pr-2 text-white/60 truncate max-w-[160px]" title={readings[t.field]}>
                                      {readings[t.field] || "—"}
                                    </td>
                                    <td className="py-1.5">
                                      <div className="flex flex-wrap gap-1 items-center">
                                        <button
                                          onClick={() => startCalibrating(t.field)}
                                          disabled={calibratingField === t.field || t.phase !== match.state}
                                          title={t.phase !== match.state ? "Switch the phase dropdown to this tracker's phase to calibrate it" : undefined}
                                          className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
                                        >
                                          {calibratingField === t.field ? "Adjusting..." : calibrated ? "Resize" : "Calibrate"}
                                        </button>
                                        {calibrated && (
                                          <>
                                            <button
                                              onClick={() => {
                                                clearRegionCoords(t.field);
                                                if (calibratingField === t.field) setDraftBox(null);
                                              }}
                                              title="Clear calibration (keeps the tracker)"
                                              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                                            >
                                              Clear
                                            </button>
                                            <button
                                              onClick={() => saveRegionAsTournamentDefault(t)}
                                              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                                              title="New matches in this tournament will start with this tracker already calibrated"
                                            >
                                              {savedDefaultField === t.field ? "Saved ✓" : "Save as default"}
                                            </button>
                                          </>
                                        )}
                                        <button
                                          onClick={() => removeTracker(t)}
                                          title="Remove this tracker entirely"
                                          className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
                                        >
                                          Remove
                                        </button>
                                        {isCountdownLike && (
                                          <span className="flex gap-1">
                                            <input
                                              value={manualTimeInputs[t.field] ?? ""}
                                              onChange={(e) => setManualTimeInputs((prev) => ({ ...prev, [t.field]: e.target.value }))}
                                              placeholder="MM:SS"
                                              className="w-16 bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[10px]"
                                            />
                                            <button
                                              onClick={() => {
                                                const value = manualTimeInputs[t.field] ?? "";
                                                if (t.category === "countdown") setManualCountdown(value);
                                                else {
                                                  const { side } = fieldParts(t.field);
                                                  const teamId = side === "left" ? resolveLeftTeamId() : resolveRightTeamId();
                                                  const letter: "a" | "b" | null = teamId === match.team_a?.id ? "a" : teamId === match.team_b?.id ? "b" : null;
                                                  if (letter) setManualDraftTimer(letter, value);
                                                }
                                              }}
                                              title="Set this directly instead of waiting on OCR"
                                              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                                            >
                                              Set
                                            </button>
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
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
              <div className="lv-alert-warning flex flex-wrap items-center gap-3 text-sm px-4 py-3">
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
              <div className="lv-alert-warning flex flex-wrap items-center gap-3 text-sm px-4 py-3">
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
