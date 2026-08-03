"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";
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
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  hero: { icon_url: string | null } | null;
  player: { ign: string; team_id: string } | null;
};
type Objective = { id: string; game_id: string; team_id: string; type: string; minute_mark: number | null };
type KeyMoment = {
  id: string;
  game_id: string;
  type: string;
  description: string | null;
  minute_mark: number | null;
  created_at: string;
  player: { ign: string } | null;
  screenshot_url: string | null;
  source: string;
  is_key_moment: boolean;
};
type NetWorthPoint = { game_id: string; minute_mark: number; team_a_gold: number; team_b_gold: number };
type RosterPlayer = { id: string; ign: string; role: string | null; team_id: string; photo_url: string | null };
type Screenshot = { id: string; game_id: string; image_url: string; in_game_time: string | null; note: string | null; created_at: string };

// Same fixed left-to-right draft order as the admin live console: exp
// lane, jungler, mid laner, gold laner, roamer.
const ROLE_ORDER = ["Exp Laner", "Jungler", "Mid Laner", "Gold Laner", "Roamer"];
function roleIndex(role: string | null | undefined) {
  const i = ROLE_ORDER.indexOf(role ?? "");
  return i === -1 ? ROLE_ORDER.length : i;
}

function youtubeEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return idMatch ? `https://www.youtube.com/embed/${idMatch[1]}` : null;
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
  const [recapMode, setRecapMode] = useState<"simple" | "advanced">("simple");

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
        `id, status, state, custom_state_label, format, youtube_url, series_winner_team_id, update_source,
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
        "id, game_number, status, state, winner_team_id, vod_url, map, current_time_seconds, current_time_updated_at, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at"
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
        .select("id, game_id, player_id, hero_name, kills, deaths, assists, gold, player:players(ign, team_id), hero:heroes(icon_url)")
        .eq("match_id", matchId),
      supabase.from("objectives").select("id, game_id, team_id, type, minute_mark").eq("match_id", matchId).order("minute_mark"),
      supabase
        .from("key_moments")
        .select("id, game_id, type, description, minute_mark, created_at, player:players(ign), screenshot_url, source, is_key_moment")
        .eq("match_id", matchId)
        .order("created_at", { ascending: false }),
      supabase.from("net_worth_snapshots").select("game_id, minute_mark, team_a_gold, team_b_gold").eq("match_id", matchId).order("minute_mark"),
      supabase.from("game_screenshots").select("id, game_id, image_url, in_game_time, note, created_at").eq("match_id", matchId).order("created_at"),
      rosterTeamIds.length > 0
        ? supabase.from("players").select("id, ign, role, team_id, photo_url").in("team_id", rosterTeamIds)
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

  const videoUrl = selectedGame?.vod_url ?? match.youtube_url ?? match.stream?.url ?? null;
  const embedUrl = youtubeEmbedUrl(videoUrl);

  const gamePickBans = pickBans.filter((p) => p.game_id === selectedGameId);
  const gameStats = stats.filter((s) => s.game_id === selectedGameId);
  const gameObjectives = objectives.filter((o) => o.game_id === selectedGameId);
  const gameNetWorth = netWorth.filter((n) => n.game_id === selectedGameId);
  const gameScreenshots = screenshots.filter((s) => s.game_id === selectedGameId);

  const teamAStats = gameStats.filter((s) => s.player?.team_id === teamAId);
  const teamBStats = gameStats.filter((s) => s.player?.team_id === teamBId);
  const teamAKills = teamAStats.reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamBKills = teamBStats.reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamABans = gamePickBans.filter((p) => p.team_id === teamAId && p.type === "ban");
  const teamAPicks = gamePickBans
    .filter((p) => p.team_id === teamAId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));
  const teamBBans = gamePickBans.filter((p) => p.team_id === teamBId && p.type === "ban");
  const teamBPicks = gamePickBans
    .filter((p) => p.team_id === teamBId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));

  const chartData = gameNetWorth.map((n) => ({
    minute: n.minute_mark,
    diff: n.team_a_gold - n.team_b_gold,
  }));

  const mvp =
    match.status === "finished" && gameStats.length > 0
      ? [...gameStats].sort((a, b) => (b.kills + b.assists - b.deaths) - (a.kills + a.assists - a.deaths))[0]
      : null;

  const gamesWonByA = games.filter((g) => g.winner_team_id === teamAId).length;
  const gamesWonByB = games.filter((g) => g.winner_team_id === teamBId).length;
  const seriesWinnerTeamId =
    match.series_winner_team_id ??
    (gamesWonByA > gamesWonByB ? teamAId : gamesWonByB > gamesWonByA ? teamBId : null) ??
    null;
  const seriesWinnerName =
    seriesWinnerTeamId === teamAId ? match.team_a?.name : seriesWinnerTeamId === teamBId ? match.team_b?.name : null;

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-8 max-w-5xl mx-auto space-y-8">
      <header className="space-y-1">
        <p className="text-xs text-white/50 uppercase tracking-wide">{match.tournament?.name} · {match.tournament?.tier}-Tier · {match.format}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-display font-light text-2xl sm:text-3xl tracking-tight flex items-center gap-2 flex-wrap">
            {match.team_a?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={proxiedImageUrl(match.team_a.logo_url)}
                alt=""
                className={`w-8 h-8 rounded object-contain ${
                  match.status === "finished" && seriesWinnerTeamId === teamAId ? "ring-2 ring-signal" : ""
                }`}
              />
            )}
            <span className={match.status === "finished" && seriesWinnerTeamId === teamAId ? "text-signal" : ""}>
              {match.team_a?.name}
            </span>
            <span className="text-white/30">vs</span>
            <span className={match.status === "finished" && seriesWinnerTeamId === teamBId ? "text-signal" : ""}>
              {match.team_b?.name}
            </span>
            {match.team_b?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={proxiedImageUrl(match.team_b.logo_url)}
                alt=""
                className={`w-8 h-8 rounded object-contain ${
                  match.status === "finished" && seriesWinnerTeamId === teamBId ? "ring-2 ring-signal" : ""
                }`}
              />
            )}
          </h1>
          <span className={match.status === "live" ? "lv-badge-live" : match.status === "finished" ? "lv-badge-finished" : "lv-badge-scheduled"}>
            {match.status}
          </span>
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
          {liveCountdownLabel && (
            <span className="lv-badge bg-white/10 text-white/70 tabular-nums" title="Starts in">
              ⏳ Starts in {liveCountdownLabel}
            </span>
          )}
          {(liveDraftTimerA || liveDraftTimerB) && (
            <span className="lv-badge bg-white/10 text-white/70 tabular-nums" title="Draft pick timer">
              ⏳ {match.team_a?.name}: {liveDraftTimerA ?? "—"} · {match.team_b?.name}: {liveDraftTimerB ?? "—"}
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

        {match.status === "finished" && seriesWinnerName && (
          <p className="text-sm font-semibold text-signal">
            🏆 {seriesWinnerName} wins {Math.max(gamesWonByA, gamesWonByB)}–{Math.min(gamesWonByA, gamesWonByB)}
          </p>
        )}
        {mvp && (
          <p className="text-sm text-white/70">
            Game {selectedGame?.game_number} MVP: {mvp.player?.ign} ({mvp.hero_name}) — {mvp.kills}/{mvp.deaths}/{mvp.assists}
          </p>
        )}
      </header>

      {match.update_source === "local_ocr" && (
        <section>
          <h2 className="lv-heading mb-2">Moment list</h2>
          {/* Sized to show ~10 moments before scrolling — newest always on
              top (query is sorted created_at desc), older ones scroll into
              view instead of being cut off. */}
          <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {keyMoments.map((km) =>
              km.is_key_moment ? (
                <div key={km.id} className="lv-card-flush p-3 flex gap-3 items-start border border-signal/40 bg-signal/10">
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
                      {match.state === "GAME_STARTED" && km.minute_mark != null && ` · ${km.minute_mark}' in-game`}
                    </p>
                  </div>
                </div>
              ) : (
                <div key={km.id} className="flex items-center gap-2 text-xs text-white/60">
                  <span className="text-white/30 tabular-nums">{new Date(km.created_at).toLocaleTimeString()}</span>
                  {match.state === "GAME_STARTED" && km.minute_mark != null && (
                    <span className="text-white/30 tabular-nums">{km.minute_mark}&apos;</span>
                  )}
                  <span>
                    {km.description ?? km.type.replace(/_/g, " ")}
                    {!km.description && km.player?.ign ? ` — ${km.player.ign}` : ""}
                  </span>
                  {km.screenshot_url && <span>📸</span>}
                </div>
              )
            )}
            {keyMoments.length === 0 && <span className="text-white/30 text-xs">No moments logged yet.</span>}
          </div>
        </section>
      )}

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

      {selectedGame?.map && (
        <p className="text-xs text-white/40">Map: <span className="text-white/60">{selectedGame.map}</span></p>
      )}

      {embedUrl ? (
        <div className="lv-card-flush overflow-hidden">
          <iframe src={embedUrl} className="w-full aspect-video" allow="autoplay; encrypted-media" allowFullScreen />
        </div>
      ) : (
        videoUrl && (
          <a href={videoUrl} target="_blank" className="lv-nav-link block">
            Watch Game {selectedGame?.game_number} ↗ (link not embeddable)
          </a>
        )
      )}

      {chartData.length > 1 && (
        <section>
          <h2 className="lv-heading mb-2">Net worth difference</h2>
          <p className="text-xs text-white/50 mb-2">Positive = {match.team_a?.name} ahead. Negative = {match.team_b?.name} ahead.</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff15" />
              <XAxis dataKey="minute" stroke="#ffffff60" tick={{ fontSize: 12 }} label={{ value: "minute", position: "insideBottom", fill: "#ffffff60", fontSize: 11, dy: 10 }} />
              <YAxis stroke="#ffffff60" tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ background: "#0A0A0A", border: "1px solid #ffffff20" }} />
              <Line type="monotone" dataKey="diff" stroke="#E31E2A" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}

      <section>
        <h2 className="lv-heading mb-2">Draft recap {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          {[
            { name: match.team_a?.name, bans: teamABans, picks: teamAPicks, teamId: teamAId },
            { name: match.team_b?.name, bans: teamBBans, picks: teamBPicks, teamId: teamBId },
          ].map((t, i) => (
            <div key={i} className="lv-card-flush p-4 space-y-2">
              <p className="text-white/70 font-semibold">{t.name}</p>
              <div className="text-xs text-white/40 flex items-center gap-1.5 flex-wrap">
                <span>Bans:</span>
                {t.bans.length === 0 && "—"}
                {t.bans.map((b) => (
                  <span key={b.id} className="inline-flex items-center gap-1">
                    {b.hero?.icon_url && <img src={proxiedImageUrl(b.hero.icon_url)} alt="" className="w-4 h-4 rounded-full object-cover object-top grayscale opacity-70" />}
                    {b.hero_name}
                  </span>
                ))}
              </div>
              <div className="text-xs text-white/40 space-y-0.5">
                <p>Picks:</p>
                {t.picks.length === 0 && <p className="pl-2">—</p>}
                {t.picks.map((p) => (
                  <p key={p.id} className="pl-2 flex items-center gap-1.5">
                    {p.hero?.icon_url && <img src={proxiedImageUrl(p.hero.icon_url)} alt="" className="w-5 h-5 rounded-full object-cover object-top" />}
                    <span>
                      {p.hero_name}
                      {p.player?.ign ? <span className="text-white/60"> — {p.player.ign}{p.player.role ? ` (${p.player.role})` : ""}</span> : ""}
                    </span>
                  </p>
                ))}
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
                    {type} <span className="font-bold tabular-nums text-white">{gameObjectives.filter((o) => o.team_id === t.teamId && o.type === type).length}</span>
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
          {gameStats.length > 0 && (
            <p className="text-sm tabular-nums">
              <span className={teamAKills > teamBKills ? "text-signal font-semibold" : "text-white/60"}>{teamAKills}</span>
              <span className="text-white/30"> — </span>
              <span className={teamBKills > teamAKills ? "text-signal font-semibold" : "text-white/60"}>{teamBKills}</span>
              <span className="text-white/40 text-xs"> kills</span>
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[
            { name: match.team_a?.name, list: teamAStats },
            { name: match.team_b?.name, list: teamBStats },
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
                      <td className="py-1.5">{s.player?.ign}</td>
                      <td className="flex items-center gap-1.5 py-1.5">
                        {s.hero?.icon_url && <img src={proxiedImageUrl(s.hero.icon_url)} alt="" className="w-5 h-5 rounded-full object-cover object-top" />}
                        {s.hero_name}
                      </td>
                      <td className="tabular-nums">{s.kills}</td>
                      <td className="tabular-nums">{s.deaths}</td>
                      <td className="tabular-nums">{s.assists}</td>
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.image_url} alt="" className="w-full rounded-md border border-white/10" />
              <p className="text-[10px] text-white/40">
                {s.in_game_time ? `${s.in_game_time} in-game` : ""}
                {s.in_game_time && " · "}
                {new Date(s.created_at).toLocaleString()}
              </p>
              {s.note && <p className="text-[10px] text-white/50">{s.note}</p>}
            </div>
          ))}
          {gameScreenshots.length === 0 && <span className="text-white/30 text-xs">No screenshots yet.</span>}
        </div>
      </section>
      </>
      )}

      {match.status === "finished" && (
        <section>
          <h2 className="lv-heading mb-2">Share recap</h2>
          <div className="flex flex-wrap items-start gap-4">
            <div className="lv-card-flush p-2 overflow-hidden" style={{ width: recapRatio === "portrait" ? 135 : 240 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/recap-card/${match.id}?ratio=${recapRatio}&mode=${recapMode}`}
                alt="Match recap card"
                className="w-full rounded"
              />
            </div>
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
                    {r === "portrait" ? "9:16" : "16:9"}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {(["simple", "advanced"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRecapMode(m)}
                    className={`px-3 py-1.5 rounded border capitalize ${
                      recapMode === m ? "border-signal text-signal" : "border-white/10 text-white/50 hover:bg-white/5"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <a
                href={`/api/recap-card/${match.id}?ratio=${recapRatio}&mode=${recapMode}`}
                download={`livevival-${match.team_a?.name}-vs-${match.team_b?.name}.png`}
                className="lv-btn-primary inline-block !text-xs !py-1.5"
              >
                Download
              </a>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
