"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { HeroIcon } from "@/components/HeroIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { BrandLockup } from "@/components/Brand";
import { formatCountdown, COUNTDOWN_WINDOW_MS } from "@/lib/countdown";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type Match = {
  id: string;
  status: string;
  state: string;
  custom_state_label: string | null;
  format: string | null;
  youtube_url: string | null;
  series_winner_team_id: string | null;
  update_source: "liquipedia" | "local_ocr";
  scheduled_at: string | null;
  countdown_seconds: number | null;
  countdown_updated_at: string | null;
  draft_timer_a_seconds: number | null;
  draft_timer_b_seconds: number | null;
  draft_timer_updated_at: string | null;
  tournament: { name: string; tier: string } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
  stream: { url: string } | null;
};

// Same phase set as the admin live console (matches the match_state enum).
// Only shown for live matches — for scheduled/finished ones the plainer
// status badge already says everything useful.
const PHASE_LABELS: Record<string, string> = {
  MATCH_NOT_STARTED: "Waiting",
  DRAFT_STARTED: "Draft in progress",
  DRAFT_COMPLETE: "Draft complete",
  GAME_STARTED: "Game ongoing",
  GAME_FINISHED: "Game finished",
  SERIES_FINISHED: "Match finished",
  TECHNICAL_PAUSE: "Technical pause",
};
type Game = {
  id: string;
  game_number: number;
  status: string;
  state: string;
  winner_team_id: string | null;
  vod_url: string | null;
  map: string | null;
  current_time_seconds: number | null;
  current_time_updated_at: string | null;
  clock_source: "ocr" | "manual";
  manual_time_seconds: number | null;
  manual_time_running: boolean;
  manual_time_started_at: string | null;
  team_a_kills_override: number | null;
  team_b_kills_override: number | null;
};
type PickBan = {
  id: string;
  game_id: string;
  team_id: string;
  player_id: string | null;
  hero_name: string;
  type: "pick" | "ban";
  pick_order: number | null;
  hero: { icon_url: string | null } | null;
  player: { ign: string; role: string | null } | null;
};
type PlayerStat = {
  id: string;
  game_id: string;
  player_id: string;
  hero_name: string | null;
  // null = TBD, not yet entered — see the admin console's PlayerStat comment.
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  gold: number;
  hero: { icon_url: string | null } | null;
  player: { ign: string; team_id: string; is_active_roster: boolean } | null;
};
type Objective = { id: string; game_id: string; team_id: string; type: string; minute_mark: number | null };
const OBJECTIVE_ICONS: Record<string, string> = { tower: "🗼", lord: "👑", turtle: "🐢" };
type KeyMoment = {
  id: string;
  game_id: string;
  type: string;
  description: string | null;
  minute_mark: number | null;
  second_mark: number | null;
  created_at: string;
  player: { ign: string } | null;
  screenshot_url: string | null;
  source: string;
  is_key_moment: boolean;
};
type NetWorthPoint = { game_id: string; minute_mark: number; team_a_gold: number; team_b_gold: number };
type RosterPlayer = { id: string; ign: string; role: string | null; team_id: string; photo_url: string | null; is_active_roster: boolean };
type Screenshot = { id: string; game_id: string; image_url: string; in_game_time: string | null; note: string | null; created_at: string };

// Same fixed left-to-right draft order as the admin live console: exp
// lane, jungler, mid laner, roamer, gold laner.
const ROLE_ORDER = ["Exp Laner", "Jungler", "Mid Laner", "Roamer", "Gold Laner"];
function roleIndex(role: string | null | undefined) {
  const i = ROLE_ORDER.indexOf(role ?? "");
  return i === -1 ? ROLE_ORDER.length : i;
}

// Per-game VODs frequently point at ONE shared base video with a per-game
// `?t=<seconds>` (or `&start=`) offset rather than separate URLs each —
// confirmed against real data (all 7 games of a BO7 pointing at the same
// youtu.be/<id> with only `t=` differing). Dropping that offset (as the
// old version did) meant every game produced the exact same embed URL, so
// switching games never even changed the iframe's src — the player just
// sat on game 1's src the whole time. Carry the offset through as `start=`
// (the embed player's own param name for it) so both the video ID AND the
// seek position change per game.
function youtubeEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  if (!idMatch) return null;
  const startMatch = url.match(/[?&](?:t|start)=(\d+)/);
  return `https://www.youtube.com/embed/${idMatch[1]}${startMatch ? `?start=${startMatch[1]}` : ""}`;
}

// Facebook's own embed plugin just wants the original video/live URL
// URL-encoded as `href` — no video-ID extraction needed the way YouTube's
// embed player requires. Closes most of the "stream doesn't embed" gap:
// streams.platform already distinguishes youtube/facebook/other, but
// nothing branched on it before this — a Facebook Live link always fell
// through to the plain "not embeddable" link even though Facebook's own
// plugin can embed it just fine.
function facebookEmbedUrl(url: string | null) {
  if (!url) return null;
  if (!/facebook\.com|fb\.watch/i.test(url)) return null;
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
}

// YouTube's live chat has its own dedicated embed (separate iframe from the
// player) — only available for YouTube, which is the only platform this
// page actually embeds a player for (see youtubeEmbedUrl above / the
// "link not embeddable" fallback for anything else).
function youtubeChatEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  if (!idMatch) return null;
  const domain = typeof window !== "undefined" ? window.location.hostname : "livevival-sigma.vercel.app";
  return `https://www.youtube.com/live_chat?v=${idMatch[1]}&embed_domain=${domain}`;
}

export default function PublicMatchPage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [pickBans, setPickBans] = useState<PickBan[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthPoint[]>([]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [watchingNow, setWatchingNow] = useState(1);
  const [recapRatio, setRecapRatio] = useState<"portrait" | "landscape">("portrait");
  const [copied, setCopied] = useState(false);
  const [recapPreviewOpen, setRecapPreviewOpen] = useState(false);
  const [screenshotPreview, setScreenshotPreview] = useState<Screenshot | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Supabase Realtime Presence — each open tab tracks itself under a random
  // key on a per-match channel; presenceState()'s key count is how many
  // tabs are currently on this page. Pure ephemeral broadcast, no table
  // involved, so it costs nothing to leave running.
  useEffect(() => {
    if (!matchId) return;
    const channel = supabase.channel(`presence-match-${matchId}`, {
      config: { presence: { key: crypto.randomUUID() } },
    });
    channel
      .on("presence", { event: "sync" }, () => {
        setWatchingNow(Object.keys(channel.presenceState()).length || 1);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") await channel.track({ at: Date.now() });
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchError } = await supabase
      .from("matches")
      .select(
        `id, status, state, custom_state_label, format, youtube_url, series_winner_team_id, update_source, scheduled_at,
         countdown_seconds, countdown_updated_at, draft_timer_a_seconds, draft_timer_b_seconds, draft_timer_updated_at,
         tournament:tournaments(name, tier),
         team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
         team_b:teams!matches_team_b_id_fkey(id, name, logo_url),
         stream:streams!matches_stream_id_fkey(url)`
      )
      .eq("id", matchId)
      .single();
    if (matchError) {
      setLoadError(matchError.message);
      return;
    }
    if (!matchData) {
      setLoadError("No match found with this ID.");
      return;
    }
    setMatch(matchData as unknown as Match);

    const { data: gameRows } = await supabase
      .from("games")
      .select(
        "id, game_number, status, state, winner_team_id, vod_url, map, current_time_seconds, current_time_updated_at, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, team_a_kills_override, team_b_kills_override"
      )
      .eq("match_id", matchId)
      .order("game_number", { ascending: true });
    const gameList = (gameRows as Game[]) ?? [];
    setGames(gameList);

    if (gameList.length > 0) {
      setSelectedGameId((prev) => {
        if (prev && gameList.some((g) => g.id === prev)) return prev;
        const live = gameList.find((g) => g.status === "live");
        return live?.id ?? gameList[gameList.length - 1].id;
      });
    }

    // hero_picks_bans.player_id is always null for Liquipedia-sourced
    // matches — the bracket picks/bans popup this scraper reads has no
    // player-per-hero attribution at all (confirmed against the scraper's
    // own selectors). The "Players" section below falls back to each
    // team's full roster instead of trying to derive a per-game lineup
    // from picks that were never going to have that data.
    const rosterTeamIds = [
      (matchData.team_a as unknown as { id: string } | null)?.id,
      (matchData.team_b as unknown as { id: string } | null)?.id,
    ].filter((id): id is string => Boolean(id));

    const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: nw }, { data: ss }, { data: rp }] = await Promise.all([
      supabase
        .from("hero_picks_bans")
        .select("id, game_id, team_id, player_id, hero_name, type, pick_order, player:players(ign, role), hero:heroes(icon_url)")
        .eq("match_id", matchId)
        .order("pick_order"),
      supabase
        .from("player_stats")
        .select(
          "id, game_id, player_id, hero_name, kills, deaths, assists, gold, player:players(ign, team_id, is_active_roster), hero:heroes(icon_url)"
        )
        .eq("match_id", matchId),
      supabase.from("objectives").select("id, game_id, team_id, type, minute_mark").eq("match_id", matchId).order("minute_mark"),
      supabase
        .from("key_moments")
        .select("id, game_id, type, description, minute_mark, second_mark, created_at, player:players(ign), screenshot_url, source, is_key_moment")
        .eq("match_id", matchId)
        .order("created_at", { ascending: false }),
      supabase.from("net_worth_snapshots").select("game_id, minute_mark, team_a_gold, team_b_gold").eq("match_id", matchId).order("minute_mark"),
      supabase.from("game_screenshots").select("id, game_id, image_url, in_game_time, note, created_at").eq("match_id", matchId).order("created_at"),
      rosterTeamIds.length > 0
        ? supabase.from("players").select("id, ign, role, team_id, photo_url, is_active_roster").in("team_id", rosterTeamIds)
        : Promise.resolve({ data: [] as RosterPlayer[] }),
    ]);
    setPickBans((pb as unknown as PickBan[]) ?? []);
    setStats((ps as unknown as PlayerStat[]) ?? []);
    setObjectives((obj as Objective[]) ?? []);
    setKeyMoments((km as unknown as KeyMoment[]) ?? []);
    setNetWorth((nw as NetWorthPoint[]) ?? []);
    setScreenshots((ss as Screenshot[]) ?? []);
    setRoster((rp as RosterPlayer[]) ?? []);
  }, [matchId]);

  useEffect(() => {
    loadAll();

    const channel = supabase
      .channel(`match-${matchId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "hero_picks_bans", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_stats", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "objectives", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "key_moments", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "net_worth_snapshots", filter: `match_id=eq.${matchId}` }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "game_screenshots", filter: `match_id=eq.${matchId}` }, loadAll)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, loadAll]);

  // Safety net alongside the Realtime subscription above, not a
  // replacement for it — a websocket can silently drop (a corporate
  // proxy, a browser extension, a reconnect that doesn't come back) with
  // no visible error, which reads as "the moment list needs a refresh."
  // This guarantees new moments/scores show up within ~10s regardless of
  // whatever's wrong with that connection at any given moment.
  useEffect(() => {
    const interval = setInterval(loadAll, 10000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (loadError) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center text-sm gap-2 px-6 text-center">
        <p className="text-red-400">Couldn&apos;t load this match: {loadError}</p>
        <a href="/" className="lv-nav-link">Back to homepage</a>
      </main>
    );
  }
  if (!match) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  const teamAId = match.team_a?.id;
  const teamBId = match.team_b?.id;

  const selectedGame = games.find((g) => g.id === selectedGameId) ?? null;

  // Ticks up client-side between OCR reads instead of only jumping every
  // capture interval — current_time_updated_at (OCR) / manual_time_started_at
  // (manual stopwatch) anchors it to real time. clock_source picks which of
  // the two the admin wants shown publicly for this game.
  const liveGameClock =
    match.state !== "GAME_STARTED" || !selectedGame
      ? null
      : selectedGame.clock_source === "manual"
      ? selectedGame.manual_time_seconds != null
        ? selectedGame.manual_time_seconds +
          (selectedGame.manual_time_running && selectedGame.manual_time_started_at
            ? Math.floor((nowMs - new Date(selectedGame.manual_time_started_at).getTime()) / 1000)
            : 0)
        : null
      : selectedGame.current_time_seconds != null && selectedGame.current_time_updated_at
      ? selectedGame.current_time_seconds + Math.floor((nowMs - new Date(selectedGame.current_time_updated_at).getTime()) / 1000)
      : null;
  const liveGameClockLabel =
    liveGameClock != null ? `${String(Math.floor(liveGameClock / 60)).padStart(2, "0")}:${String(liveGameClock % 60).padStart(2, "0")}` : null;

  function formatMMSS(totalSeconds: number) {
    const clamped = Math.max(0, totalSeconds);
    return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
  }

  // Same 24h-out countdown as the home page's Upcoming cards, keyed off
  // the match's own scheduled_at rather than an OCR-read value — this
  // works for any scheduled match regardless of update_source, not just
  // Hot matches with a live countdown tracker.
  const scheduledCountdownMs = match.scheduled_at ? new Date(match.scheduled_at).getTime() - nowMs : null;
  const scheduledCountdownLabel =
    match.status === "scheduled" && scheduledCountdownMs != null && scheduledCountdownMs > 0 && scheduledCountdownMs <= COUNTDOWN_WINDOW_MS
      ? formatCountdown(scheduledCountdownMs)
      : null;

  // Waiting phase: counts DOWN client-side from the last OCR read. No
  // countdown detected at all (the field stays null) usually means a
  // TVC/caster session rather than a real pre-game clock.
  const liveCountdownLabel =
    match.state === "MATCH_NOT_STARTED" && match.countdown_seconds != null && match.countdown_updated_at
      ? formatMMSS(match.countdown_seconds - Math.floor((nowMs - new Date(match.countdown_updated_at).getTime()) / 1000))
      : null;

  // Draft phase: same idea, one countdown per side.
  const draftElapsed = match.draft_timer_updated_at ? Math.floor((nowMs - new Date(match.draft_timer_updated_at).getTime()) / 1000) : 0;
  const liveDraftTimerA =
    match.state === "DRAFT_STARTED" && match.draft_timer_a_seconds != null ? formatMMSS(match.draft_timer_a_seconds - draftElapsed) : null;
  const liveDraftTimerB =
    match.state === "DRAFT_STARTED" && match.draft_timer_b_seconds != null ? formatMMSS(match.draft_timer_b_seconds - draftElapsed) : null;

  // Whose turn it is to pick/ban — inferred from the pick/ban tool's own
  // state (how many rows are already logged for this game) rather than
  // from which timer looks like it's counting down, since both sides'
  // timers decrement identically client-side (see above) and can't
  // actually distinguish "on the clock" from "waiting." The admin's draft
  // simulation always logs in this exact fixed order (see DRAFT_SEQUENCE
  // in the live console), so the count of already-logged picks/bans for
  // this game is itself the step index — and the very first logged row's
  // team is always the "blue" side by construction, so it doubles as the
  // blue/red -> team_a/team_b key with no separate DB field needed.
  const DRAFT_TURN_SIDES: ("blue" | "red")[] = [
    "blue", "red", "blue", "red", "blue", "red",
    "blue", "red", "red", "blue", "blue", "red",
    "red", "blue", "red", "blue",
    "red", "blue", "blue", "red",
  ];
  const draftOrderedPickBans = [...pickBans]
    .filter((p) => p.game_id === selectedGameId)
    .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  const blueTeamId = draftOrderedPickBans[0]?.team_id ?? null;
  const draftTurnTeamId =
    match.state === "DRAFT_STARTED" && blueTeamId && draftOrderedPickBans.length < DRAFT_TURN_SIDES.length
      ? DRAFT_TURN_SIDES[draftOrderedPickBans.length] === "blue"
        ? blueTeamId
        : blueTeamId === teamAId ? teamBId : teamAId
      : null;

  const videoUrl = selectedGame?.vod_url ?? match.youtube_url ?? match.stream?.url ?? null;
  const embedUrl = youtubeEmbedUrl(videoUrl) ?? facebookEmbedUrl(videoUrl);
  // Chat only makes sense against the actual live stream, not a per-game
  // VOD link (a finished game's VOD has no live chat) — always the match's
  // own youtube_url, regardless of which game/VOD is currently selected.
  const chatEmbedUrl = youtubeChatEmbedUrl(match.youtube_url);

  const gamePickBans = pickBans.filter((p) => p.game_id === selectedGameId);
  const gameStats = stats.filter((s) => s.game_id === selectedGameId);
  const gameObjectives = objectives.filter((o) => o.game_id === selectedGameId);
  const gameNetWorth = netWorth.filter((n) => n.game_id === selectedGameId);
  const gameScreenshots = screenshots.filter((s) => s.game_id === selectedGameId);

  // Substitutes/unselected players never show on the Live Scoreboard —
  // only whoever the roster editor has flagged as the active five.
  // is_active_roster !== false (rather than === true) treats a missing
  // join as "include it" so this can't silently blank the scoreboard for
  // older rows from before the column existed.
  const teamAStats = gameStats.filter((s) => s.player?.team_id === teamAId && s.player?.is_active_roster !== false);
  const teamBStats = gameStats.filter((s) => s.player?.team_id === teamBId && s.player?.is_active_roster !== false);
  // A direct team-kills OCR tracker overrides the summed player_stats total
  // once it's read anything (see the admin live console's captureTickBody).
  const teamAKills = selectedGame?.team_a_kills_override ?? teamAStats.reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamBKills = selectedGame?.team_b_kills_override ?? teamBStats.reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamAActiveRoster = roster.filter((p) => p.team_id === teamAId && p.is_active_roster);
  const teamBActiveRoster = roster.filter((p) => p.team_id === teamBId && p.is_active_roster);
  // Once both teams have their 5-player roster decided, show it on the
  // scoreboard even before any pick/stat row exists yet for this game —
  // otherwise the scoreboard stays blank right up until the draft
  // actually produces a KDA row. Still gated on Draft having started at
  // all (see scoreRowsFor below) — before that, nobody's confirmed who's
  // actually playing this game yet.
  const rosterDecided = teamAActiveRoster.length === 5 && teamBActiveRoster.length === 5;
  type ScoreRow = { id: string; ign: string; heroIconUrl: string | null; heroName: string | null; kills: number | null; deaths: number | null; assists: number | null };
  function scoreRowsFor(stats: PlayerStat[], activeRoster: RosterPlayer[]): ScoreRow[] {
    if (stats.length > 0) {
      return stats.map((s) => ({
        id: s.id,
        ign: s.player?.ign ?? "?",
        heroIconUrl: s.hero?.icon_url ?? null,
        heroName: s.hero_name,
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
      }));
    }
    if (!rosterDecided || match?.state === "MATCH_NOT_STARTED") return [];
    return [...activeRoster]
      .sort((a, b) => roleIndex(a.role) - roleIndex(b.role))
      .map((p) => ({ id: p.id, ign: p.ign, heroIconUrl: null, heroName: null, kills: null, deaths: null, assists: null }));
  }
  const teamABans = gamePickBans.filter((p) => p.team_id === teamAId && p.type === "ban");
  const teamAPicks = gamePickBans
    .filter((p) => p.team_id === teamAId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));
  const teamBBans = gamePickBans.filter((p) => p.team_id === teamBId && p.type === "ban");
  const teamBPicks = gamePickBans
    .filter((p) => p.team_id === teamBId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));

  // Each team's own gold total plotted directly (not a difference line) —
  // "positive/negative" was ambiguous about which side that even meant;
  // two labeled lines just show who's ahead at a glance.
  const chartData = gameNetWorth.map((n) => ({
    minute: n.minute_mark,
    teamA: n.team_a_gold,
    teamB: n.team_b_gold,
  }));

  const mvp =
    match.status === "finished" && gameStats.length > 0
      ? [...gameStats].sort(
          (a, b) => (b.kills ?? 0) + (b.assists ?? 0) - (b.deaths ?? 0) - ((a.kills ?? 0) + (a.assists ?? 0) - (a.deaths ?? 0))
        )[0]
      : null;

  const gamesWonByA = games.filter((g) => g.winner_team_id === teamAId).length;
  const gamesWonByB = games.filter((g) => g.winner_team_id === teamBId).length;
  const seriesWinnerTeamId =
    match.series_winner_team_id ??
    (gamesWonByA > gamesWonByB ? teamAId : gamesWonByB > gamesWonByA ? teamBId : null) ??
    null;
  const seriesWinnerName =
    seriesWinnerTeamId === teamAId ? match.team_a?.name : seriesWinnerTeamId === teamBId ? match.team_b?.name : null;

  const gameNumberById = new Map(games.map((g) => [g.id, g.game_number]));

  // navigator.share() triggers the OS share sheet — the only way a browser
  // reaches WhatsApp/Telegram/Threads/X/IG/FB/etc. directly, since there's
  // no single API that posts to all of those. Falls back to copy-link for
  // browsers/desktop that don't support it (also offered as its own
  // explicit button, since some users on a supported browser still prefer
  // a plain link over the share sheet).
  async function handleShare() {
    const shareTitle = `${match?.team_a?.name} vs ${match?.team_b?.name} — Livevival`;
    const shareText = seriesWinnerName
      ? `🏆 ${seriesWinnerName} wins ${Math.max(gamesWonByA, gamesWonByB)}–${Math.min(gamesWonByA, gamesWonByB)}`
      : "Match recap on Livevival";

    // Attaching the actual recap image (portrait = the same 1080x1920 IG/
    // FB/TikTok Story dimensions) is what lets "Share" post the image
    // itself to a Story — most story composers won't auto-fetch a plain
    // link as media. Only attempted when the share sheet actually supports
    // file attachments; any outcome here (shared or cancelled) is final,
    // no fallback double-prompt afterward.
    if (typeof navigator.canShare === "function") {
      try {
        const res = await fetch(`/api/recap-card/${match?.id}?ratio=${recapRatio}`);
        const blob = await res.blob();
        const file = new File([blob], "livevival-recap.png", { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ title: shareTitle, text: shareText, files: [file] });
          } catch {
            // User cancelled the share sheet — not an error worth surfacing.
          }
          return;
        }
      } catch {
        // Image fetch failed — fall through to a plain link share instead.
      }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, text: shareText, url: window.location.href });
      } catch {
        // User cancelled the share sheet — not an error worth surfacing.
      }
    } else {
      await handleCopyLink();
    }
  }

  async function handleCopyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Same "attach the actual image, fall back to a link" pattern as
  // handleShare above — the screenshot itself already has the Livevival
  // watermark + match/tournament caption baked in at capture time
  // (app/admin/matches/[id]/live/page.tsx's drawWatermark), so sharing the
  // image file is what actually carries that branding along with it.
  async function handleShareScreenshot(s: Screenshot) {
    const shareTitle = `${match?.team_a?.name} vs ${match?.team_b?.name} — Livevival`;
    if (typeof navigator.canShare === "function") {
      try {
        const res = await fetch(s.image_url);
        const blob = await res.blob();
        const file = new File([blob], "livevival-screenshot.jpg", { type: blob.type || "image/jpeg" });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ title: shareTitle, files: [file] });
          } catch {
            // User cancelled the share sheet — not an error worth surfacing.
          }
          return;
        }
      } catch {
        // Image fetch failed — fall through to a plain link share instead.
      }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url: s.image_url });
      } catch {
        // User cancelled the share sheet — not an error worth surfacing.
      }
    } else {
      await navigator.clipboard.writeText(s.image_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-8 max-w-5xl mx-auto space-y-8">
      <header className="space-y-1">
        {/* A shared link, arriving straight on this page (e.g. from a
            Telegram share), previously had no way back to the match list
            at all — the only existing home link only ever rendered in the
            load-error state above, never here in the normal render path. */}
        <div className="flex items-center justify-between">
          <BrandLockup imgClassName="h-6 w-auto" />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <NavMenu />
          </div>
        </div>
        <p className="text-xs text-white/50 uppercase tracking-wide">{match.tournament?.name} · {match.tournament?.tier}-Tier · {match.format}</p>
        <div className="flex items-center gap-3 flex-wrap">
          {/* items-start (not items-end) — the logo is always the first
              thing in each team's column, so top-aligning the row is what
              keeps both logo squares level regardless of how many lines
              the team name below wraps to (a long name like "TEAM FALCONS
              PH" wrapping to 2 lines used to push that logo upward relative
              to a 1-line name like "TEAM SPIRIT" under items-end). The
              score gets a top margin instead of the old bottom margin to
              re-center it against the now top-anchored logos. */}
          <h1 className="flex items-start gap-4 sm:gap-6">
            <div className="flex flex-col items-center gap-2 w-24 sm:w-32">
              <div className="relative">
                <TeamLogo url={match.team_a?.logo_url} size="xl" glow highlight={match.status === "finished" && seriesWinnerTeamId === teamAId} />
                {match.status === "finished" && seriesWinnerTeamId === teamAId && (
                  <span className="absolute -top-2 -right-2 text-xl sm:text-2xl drop-shadow" title="Series winner">👑</span>
                )}
              </div>
              <span
                className={`font-display font-light text-sm sm:text-base text-center leading-tight ${
                  match.status === "finished" && seriesWinnerTeamId === teamAId ? "text-signal" : ""
                }`}
              >
                {match.team_a?.name}
              </span>
            </div>
            {/* The series score is the single most-scanned number on this
                page — it now dwarfs "vs" and every other header element
                instead of being buried in the finished-only winner line. */}
            <span className="lv-score flex items-center gap-2 sm:gap-3 text-4xl sm:text-6xl mt-8 sm:mt-10">
              {games.length > 0 ? (
                <>
                  <span className={gamesWonByA > gamesWonByB ? "text-signal" : "text-paper"}>{gamesWonByA}</span>
                  <span className="text-white/20 text-2xl sm:text-4xl">–</span>
                  <span className={gamesWonByB > gamesWonByA ? "text-signal" : "text-paper"}>{gamesWonByB}</span>
                </>
              ) : (
                <span className="text-white/30 text-lg sm:text-xl font-sans">VS</span>
              )}
            </span>
            <div className="flex flex-col items-center gap-2 w-24 sm:w-32">
              <div className="relative">
                <TeamLogo url={match.team_b?.logo_url} size="xl" glow highlight={match.status === "finished" && seriesWinnerTeamId === teamBId} />
                {match.status === "finished" && seriesWinnerTeamId === teamBId && (
                  <span className="absolute -top-2 -right-2 text-xl sm:text-2xl drop-shadow" title="Series winner">👑</span>
                )}
              </div>
              <span
                className={`font-display font-light text-sm sm:text-base text-center leading-tight ${
                  match.status === "finished" && seriesWinnerTeamId === teamBId ? "text-signal" : ""
                }`}
              >
                {match.team_b?.name}
              </span>
            </div>
          </h1>
          <span className={match.status === "live" ? "lv-badge-live" : match.status === "finished" ? "lv-badge-finished" : "lv-badge-scheduled"}>
            {match.status}
          </span>
          {scheduledCountdownLabel && (
            <span
              className="lv-badge font-mono tabular-nums text-signal bg-signal/15 border border-signal/40"
              title="Time until this match starts"
            >
              ⏳ {scheduledCountdownLabel}
            </span>
          )}
          {match.status === "live" && (
            <span className="lv-badge bg-white/10 text-white/70">
              {match.state === "CUSTOM" ? match.custom_state_label || "Custom" : PHASE_LABELS[match.state] ?? match.state}
            </span>
          )}
          {liveGameClockLabel && (
            <span className="lv-badge bg-signal/15 text-signal tabular-nums" title="Live in-game clock">
              ⏱ {liveGameClockLabel}
            </span>
          )}
          {liveCountdownLabel ? (
            <span className="lv-badge bg-white/10 text-white/70 tabular-nums" title="Starts in">
              ⏳ Starts in {liveCountdownLabel}
            </span>
          ) : (
            match.state === "MATCH_NOT_STARTED" &&
            match.status === "live" && (
              <span className="lv-badge bg-white/10 text-white/60" title="No countdown detected — likely a caster segment or TVC between matches">
                🎙️ Caster / TVC intermission
              </span>
            )
          )}
          {/* Only the team actually on the clock — the other side's timer
              isn't counting down anything real (both were decrementing
              identically client-side before), so showing it just as "—"
              read as broken rather than informative. */}
          {draftTurnTeamId && (draftTurnTeamId === teamAId ? liveDraftTimerA : liveDraftTimerB) && (
            <span className="lv-badge bg-white/10 text-signal font-semibold tabular-nums" title="Draft pick/ban timer">
              ⏳ {draftTurnTeamId === teamAId ? match.team_a?.name : match.team_b?.name} turn - {draftTurnTeamId === teamAId ? liveDraftTimerA : liveDraftTimerB}
            </span>
          )}
          {match.update_source === "local_ocr" && (
            <span
              className="lv-badge bg-signal/20 text-signal border border-signal/40"
              title="Fully admin-tracked: live KDA, items, and moment log"
            >
              🔥 HOT
            </span>
          )}
          {match.status === "live" && (
            <span className="lv-badge bg-white/10 text-white/60 tabular-nums" title="People currently on this page">
              👀 {watchingNow} watching
            </span>
          )}
        </div>

        {mvp && (
          <p className="text-sm text-white/70">
            Game {selectedGame?.game_number} MVP: {mvp.player?.ign} ({mvp.hero_name}) — {mvp.kills ?? "TBD"}/{mvp.deaths ?? "TBD"}/{mvp.assists ?? "TBD"}
          </p>
        )}
      </header>

      {/* Sticky "theater mode" — stays pinned to the top of the viewport
          while everything below (moments, draft recap, stats, etc.)
          scrolls underneath it, instead of scrolling the stream itself
          out of view. A single-column sticky element does this on its
          own (no grid split needed): it sticks in place once its natural
          scroll position reaches `top`, and stays stuck because nothing
          shorter constrains it — the rest of the page just keeps scrolling
          past below. bg-ink covers the seam so nothing shows through. */}
      <div className="sticky top-0 z-10 bg-ink pt-2 pb-3 space-y-2">
        {games.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            {games.map((g) => (
              <button
                key={g.id}
                onClick={() => setSelectedGameId(g.id)}
                className={`text-xs px-3 py-1.5 rounded-md border transition-all duration-200 ${
                  selectedGameId === g.id
                    ? "bg-signal border-signal shadow-[0_0_16px_1px_rgba(232,72,58,0.4)]"
                    : "border-white/10 hover:border-signal/40 hover:bg-white/5"
                }`}
              >
                Game {g.game_number}
                {g.winner_team_id && (
                  <span className="ml-1 text-white/60">
                    ({g.winner_team_id === teamAId ? match.team_a?.name : match.team_b?.name} won)
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Capped to a medium width (was full-bleed across the whole page
            column) with chat beside it on desktop instead of stacked below
            — the Moment list underneath is meant to be the main focus, not
            the stream. Stacks back to video-then-chat on mobile where
            there's no room for two columns. */}
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-3">
          <div className="sm:w-3/5 space-y-2">
            {embedUrl ? (
              <div className="lv-card-flush overflow-hidden">
                <iframe
                  key={embedUrl}
                  src={embedUrl}
                  className="w-full aspect-video"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              </div>
            ) : (
              videoUrl && (
                <a href={videoUrl} target="_blank" className="lv-nav-link block">
                  Watch Game {selectedGame?.game_number} ↗ (link not embeddable)
                </a>
              )
            )}
          </div>
          {chatEmbedUrl && (
            <div className="sm:w-2/5 flex flex-col">
              <button
                onClick={() => setChatOpen((v) => !v)}
                className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 text-white/70 self-start sm:self-stretch"
              >
                💬 {chatOpen ? "Hide chat" : "Show chat"}
              </button>
              {chatOpen && (
                <iframe src={chatEmbedUrl} className="w-full h-56 sm:h-auto sm:flex-1 sm:min-h-0 mt-2 rounded border border-white/10" />
              )}
            </div>
          )}
        </div>
      </div>

      {match.update_source === "local_ocr" && (
        <section>
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <h2 className="lv-heading">Moment list</h2>
            {/* Header badges above can wrap/scroll out of view on mobile —
                repeating the live clock + phase here, bigger, means the
                status is still visible without scrolling back up while
                reading the moment feed. */}
            {liveGameClockLabel && (
              <span className="text-xl font-bold text-signal tabular-nums" title="Live in-game clock">
                ⏱ {liveGameClockLabel}
              </span>
            )}
            <span className="text-sm text-white/60">
              {match.state === "CUSTOM" ? match.custom_state_label || "Custom" : PHASE_LABELS[match.state] ?? match.state}
            </span>
          </div>
          {/* Sized to show ~10 moments before scrolling — newest always on
              top (query is sorted created_at desc), older ones scroll into
              view instead of being cut off. */}
          <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {keyMoments.map((km, i) => {
              // Sorted newest-first, so a separator belongs above the first
              // moment of each game (i.e. whenever the game changes from the
              // previous — chronologically later — entry above it).
              const showSeparator = games.length > 1 && (i === 0 || keyMoments[i - 1].game_id !== km.game_id);
              const gameNumber = gameNumberById.get(km.game_id);
              return (
                <div key={km.id}>
                  {showSeparator && gameNumber && (
                    <p className="text-[10px] text-white/30 uppercase tracking-wide pt-1 pb-1 first:pt-0">— Game {gameNumber} —</p>
                  )}
                  {km.is_key_moment ? (
                    <div className="lv-card-flush p-3 flex gap-3 items-start border border-signal/40 bg-signal/10">
                      {km.screenshot_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={km.screenshot_url} alt={km.type} className="w-24 rounded-md border border-white/10 shrink-0" />
                      )}
                      <div className="space-y-0.5">
                        <p className="text-signal font-semibold text-sm">
                          ⭐ {km.description ?? km.type.replace(/_/g, " ")}
                          {!km.description && km.player?.ign ? ` — ${km.player.ign}` : ""}
                        </p>
                        <p className="text-[10px] text-white/40">
                          {new Date(km.created_at).toLocaleTimeString()}
                          {match.state === "GAME_STARTED" && km.minute_mark != null &&
                            ` · ${formatMMSS(km.minute_mark * 60 + (km.second_mark ?? 0))} in-game`}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <span className="text-white/30 tabular-nums">{new Date(km.created_at).toLocaleTimeString()}</span>
                      {match.state === "GAME_STARTED" && km.minute_mark != null && (
                        <span className="text-white/30 tabular-nums">{formatMMSS(km.minute_mark * 60 + (km.second_mark ?? 0))}</span>
                      )}
                      <span>
                        {km.description ?? km.type.replace(/_/g, " ")}
                        {!km.description && km.player?.ign ? ` — ${km.player.ign}` : ""}
                      </span>
                      {km.screenshot_url && <span>📸</span>}
                    </div>
                  )}
                </div>
              );
            })}
            {keyMoments.length === 0 && <span className="text-white/30 text-xs">No moments logged yet.</span>}
          </div>
        </section>
      )}

      {selectedGame?.map && (
        <p className="text-base text-white/50">Map: <span className="text-white/80 font-semibold">{selectedGame.map}</span></p>
      )}

      {chartData.length > 1 && (
        <section>
          <h2 className="lv-heading mb-2">Net worth</h2>
          <div className="flex items-center gap-4 text-xs text-white/50 mb-2">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-signal inline-block" /> {match.team_a?.name}</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-white/60 inline-block" /> {match.team_b?.name}</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff15" />
              <XAxis dataKey="minute" stroke="#ffffff60" tick={{ fontSize: 12 }} label={{ value: "minute", position: "insideBottom", fill: "#ffffff60", fontSize: 11, dy: 10 }} />
              <YAxis stroke="#ffffff60" tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ background: "#0A0A0A", border: "1px solid #ffffff20" }} />
              <Line type="monotone" dataKey="teamA" name={match.team_a?.name ?? "Team A"} stroke="#E31E2A" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="teamB" name={match.team_b?.name ?? "Team B"} stroke="#ffffff99" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}

      <section>
        <h2 className="lv-heading mb-3">Draft recap {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          {[
            { name: match.team_a?.name, bans: teamABans, picks: teamAPicks, teamId: teamAId },
            { name: match.team_b?.name, bans: teamBBans, picks: teamBPicks, teamId: teamBId },
          ].map((t, i) => (
            <div key={i} className="lv-card-flush p-4 space-y-3">
              <p className="text-white/70 font-semibold">{t.name}</p>

              <div className="rounded-lg border border-white/10 p-3 space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Picks</p>
                {t.picks.length === 0 ? (
                  <p className="text-xs text-white/30">—</p>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {t.picks.map((p) => (
                      <div key={p.id} className="flex flex-col items-center gap-1 w-14">
                        <HeroIcon url={p.hero?.icon_url} name={p.hero_name} size="md" />
                        <span className="text-[10px] text-white/70 text-center leading-tight truncate w-full">{p.hero_name}</span>
                        {p.player?.ign && (
                          <span className="text-[9px] text-white/40 text-center leading-tight truncate w-full">{p.player.ign}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-white/10 p-3 space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Bans</p>
                {t.bans.length === 0 ? (
                  <p className="text-xs text-white/30">—</p>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {t.bans.map((b) => (
                      <div key={b.id} className="flex flex-col items-center gap-1 w-12">
                        <HeroIcon url={b.hero?.icon_url} name={b.hero_name} size="sm" banned />
                        <span className="text-[9px] text-white/40 text-center leading-tight truncate w-full">{b.hero_name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {match.update_source !== "local_ocr" && (
        <section>
          <h2 className="lv-heading mb-2">Players</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            {[
              { name: match.team_a?.name, teamId: teamAId },
              { name: match.team_b?.name, teamId: teamBId },
            ].map((t, i) => {
              // Not derived from hero_picks_bans — Liquipedia's picks/bans
              // data has no player-per-hero attribution to draw a per-game
              // lineup from, so this shows the team's full roster instead.
              const teamRoster = roster
                .filter((p) => p.team_id === t.teamId)
                .sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
              return (
                <div key={i} className="lv-card-flush p-4 space-y-1.5">
                  <p className="text-white/70 font-semibold text-sm">{t.name}</p>
                  {teamRoster.length === 0 && <p className="text-xs text-white/30">Roster not added yet.</p>}
                  {teamRoster.map((p) => (
                    <p key={p.id} className="text-xs text-white/60 flex items-center gap-1.5">
                      {p.photo_url ? (
                        <img src={p.photo_url} alt="" className="w-5 h-5 rounded-full object-cover object-top" />
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-white/10" />
                      )}
                      <span>
                        {p.ign}
                        {p.role ? ` — ${p.role}` : ""}
                      </span>
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {match.update_source === "local_ocr" && (
      <>
      <section>
        <h2 className="lv-heading mb-2">Objectives {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="flex gap-8 text-sm">
          {[
            { name: match.team_a?.name, teamId: teamAId },
            { name: match.team_b?.name, teamId: teamBId },
          ].map((t, i) => (
            <div key={i} className="space-y-1">
              <p className="text-white/50 text-xs">{t.name}</p>
              <div className="flex gap-3 text-xs">
                {(["tower", "lord", "turtle"] as const).map((type) => (
                  <span key={type} className="capitalize text-white/70">
                    {OBJECTIVE_ICONS[type]} {type}{" "}
                    <span className="font-bold tabular-nums text-white">{gameObjectives.filter((o) => o.team_id === t.teamId && o.type === type).length}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="lv-heading">Scoreboard {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        </div>
        {/* Team-kill score — large, above the scoreboard itself, not a
            small line sharing the heading row. */}
        {(gameStats.length > 0 || rosterDecided) && (
          <p className="text-4xl sm:text-5xl font-bold tabular-nums text-center mb-3">
            <span className={teamAKills > teamBKills ? "text-signal" : "text-white/70"}>{teamAKills}</span>
            <span className="text-white/30 mx-2">—</span>
            <span className={teamBKills > teamAKills ? "text-signal" : "text-white/70"}>{teamBKills}</span>
            <span className="text-white/40 text-sm font-normal block mt-1">team kills</span>
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          {[
            { name: match.team_a?.name, list: scoreRowsFor(teamAStats, teamAActiveRoster) },
            { name: match.team_b?.name, list: scoreRowsFor(teamBStats, teamBActiveRoster) },
          ].map((t, i) => (
            <div key={i} className="lv-card-flush p-4">
              <p className="text-white/70 font-semibold mb-2 text-sm">{t.name}</p>
              <table className="w-full text-xs">
                <thead className="text-white/40 text-left uppercase tracking-wide">
                  <tr><th className="pb-1.5">Player</th><th className="pb-1.5">Hero</th><th className="pb-1.5">K</th><th className="pb-1.5">D</th><th className="pb-1.5">A</th></tr>
                </thead>
                <tbody>
                  {t.list.map((s) => (
                    <tr key={s.id} className="border-t border-white/10">
                      <td className="py-1.5">{s.ign}</td>
                      <td className="flex items-center gap-1.5 py-1.5">
                        {s.heroIconUrl && <HeroIcon url={s.heroIconUrl} name={s.heroName} size="xs" />}
                        {s.heroName ?? (s.heroIconUrl === null && s.heroName === null ? "—" : "")}
                      </td>
                      <td className="tabular-nums">{s.kills ?? <span className="text-white/30">TBD</span>}</td>
                      <td className="tabular-nums">{s.deaths ?? <span className="text-white/30">TBD</span>}</td>
                      <td className="tabular-nums">{s.assists ?? <span className="text-white/30">TBD</span>}</td>
                    </tr>
                  ))}
                  {t.list.length === 0 && (
                    <tr><td colSpan={5} className="py-2 text-white/30">No stats yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="lv-heading mb-2">Screenshots {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="flex flex-wrap gap-3">
          {gameScreenshots.map((s) => (
            <div key={s.id} className="w-48 space-y-1 lv-card-flush p-2">
              {/* Opens the same preview/download/share flow as the recap
                  card below (rather than a bare new tab) — each frame
                  already carries a Livevival watermark + match/tournament
                  caption baked in at capture time, so sharing it the same
                  way the recap does is what actually gets that branding
                  in front of anyone who reposts it. */}
              <button
                type="button"
                onClick={() => setScreenshotPreview(s)}
                className="block w-full hover:opacity-90 transition-opacity"
                title="Click to preview full size"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.image_url} alt="" className="w-full rounded-md border border-white/10" />
              </button>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-white/40">
                  {s.in_game_time ? `${s.in_game_time} in-game` : ""}
                  {s.in_game_time && " · "}
                  {new Date(s.created_at).toLocaleString()}
                </p>
                <a href={s.image_url} download className="text-[10px] text-white/50 hover:text-signal shrink-0">
                  ⬇ Download
                </a>
              </div>
              {s.note && <p className="text-[10px] text-white/50">{s.note}</p>}
            </div>
          ))}
          {gameScreenshots.length === 0 && <span className="text-white/30 text-xs">No screenshots yet.</span>}
        </div>
      </section>
      </>
      )}

      {screenshotPreview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setScreenshotPreview(null)}
        >
          <div className="max-w-lg w-full flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screenshotPreview.image_url} alt="Screenshot preview" className="w-full rounded lv-card-flush" />
            <div className="flex flex-wrap gap-2 justify-center">
              <a
                href={screenshotPreview.image_url}
                download
                className="lv-btn-primary inline-block !text-xs !py-1.5"
              >
                Download
              </a>
              <button
                onClick={() => handleShareScreenshot(screenshotPreview)}
                className="lv-btn-primary inline-block !text-xs !py-1.5 !bg-white/10 !text-white"
              >
                Share ↗
              </button>
              <button
                onClick={() => setScreenshotPreview(null)}
                className="px-3 py-1.5 rounded border border-white/10 text-white/50 hover:bg-white/5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {match.status === "finished" && (
        <section>
          <h2 className="lv-heading mb-2">Share recap</h2>
          <div className="flex flex-wrap items-start gap-4">
            <button
              type="button"
              onClick={() => setRecapPreviewOpen(true)}
              className="lv-card-flush p-2 overflow-hidden hover:border-signal/40 transition-colors"
              style={{ width: recapRatio === "portrait" ? 135 : 240 }}
              title="Click to preview full size"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/recap-card/${match.id}?ratio=${recapRatio}`}
                alt="Match recap card"
                className="w-full rounded"
              />
            </button>
            <div className="space-y-3 text-xs">
              <div className="flex gap-2">
                {(["portrait", "landscape"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRecapRatio(r)}
                    className={`px-3 py-1.5 rounded border ${
                      recapRatio === r ? "border-signal text-signal" : "border-white/10 text-white/50 hover:bg-white/5"
                    }`}
                  >
                    {r === "portrait" ? "Portrait" : "Landscape"}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/api/recap-card/${match.id}?ratio=${recapRatio}`}
                  download={`livevival-${match.team_a?.name}-vs-${match.team_b?.name}.png`}
                  className="lv-btn-primary inline-block !text-xs !py-1.5"
                >
                  Download
                </a>
                <button onClick={handleShare} className="lv-btn-primary inline-block !text-xs !py-1.5 !bg-white/10 !text-white">
                  Share ↗
                </button>
                <button onClick={handleCopyLink} className="px-3 py-1.5 rounded border border-white/10 text-white/50 hover:bg-white/5">
                  {copied ? "Copied!" : "Copy link"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {recapPreviewOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setRecapPreviewOpen(false)}
        >
          <div className="max-w-lg w-full flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/recap-card/${match.id}?ratio=${recapRatio}`}
              alt="Match recap card preview"
              className="w-full rounded lv-card-flush"
            />
            <div className="flex flex-wrap gap-2 justify-center">
              <a
                href={`/api/recap-card/${match.id}?ratio=${recapRatio}`}
                download={`livevival-${match.team_a?.name}-vs-${match.team_b?.name}.png`}
                className="lv-btn-primary inline-block !text-xs !py-1.5"
              >
                Download
              </a>
              <button onClick={handleShare} className="lv-btn-primary inline-block !text-xs !py-1.5 !bg-white/10 !text-white">
                Share ↗
              </button>
              <button
                onClick={() => setRecapPreviewOpen(false)}
                className="px-3 py-1.5 rounded border border-white/10 text-white/50 hover:bg-white/5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
