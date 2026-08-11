"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { HeroIcon } from "@/components/HeroIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { BrandLockup } from "@/components/Brand";
import { FollowButton } from "@/components/FollowButton";
import { formatCountdown, COUNTDOWN_WINDOW_MS } from "@/lib/countdown";
import { formatMatchDate } from "@/lib/formatMatchDate";

type Match = {
  id: string;
  status: string;
  state: string;
  custom_state_label: string | null;
  format: string | null;
  youtube_url: string | null;
  series_winner_team_id: string | null;
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
  scheduled_at: string | null;
  countdown_seconds: number | null;
  countdown_updated_at: string | null;
  tournament: { name: string; tier: string; liquipedia_slug: string | null } | null;
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

// The site owner's revised "four states, one page" spec (superseding the
// earlier three-bucket version), expressed as close to a pure function of
// match.state as the actual requirements allow — recomputed on every
// Realtime-driven re-render with no extra effect/mount logic of its own.
// Four buckets over the match_state enum (MATCH_NOT_STARTED, DRAFT_STARTED,
// DRAFT_COMPLETE, GAME_STARTED, GAME_FINISHED, SERIES_FINISHED,
// TECHNICAL_PAUSE, CUSTOM — same set the admin live console uses):
//  - "default": MATCH_NOT_STARTED (nothing live yet — switcher, stream,
//    moment list, full player/role roster) AND GAME_FINISHED (the
//    in-between-games intermission once one game of a Bo3+ ends but the
//    series hasn't — same layout, plus that just-finished game's Draft
//    recap + Scoreboard bolted on below, see the render logic further
//    down). Also used — see the selectedGame check below — whenever the
//    switcher is pointed at an earlier, already-finished game while a
//    later game in the series is actually the live one: the site owner's
//    spec hedges this ("probably also") rather than stating it outright,
//    so this is a bounded, literal reading of that hedge, not a full
//    separate per-game state machine.
//  - "draft": DRAFT_STARTED, DRAFT_COMPLETE.
//  - "game": GAME_STARTED, TECHNICAL_PAUSE, CUSTOM — actively-playing
//    states with a live scoreboard worth showing.
//  - "finished": SERIES_FINISHED — the one state that's actually terminal.
type LayoutBucket = "default" | "draft" | "game" | "finished";
function layoutBucketFor(state: string, selectedGame: Game | null, liveGameId: string | null): LayoutBucket {
  if (state === "SERIES_FINISHED") return "finished";
  // Any game that's actually finished shows its own recap/stats — whether
  // that's mid-series (GAME_FINISHED intermission, viewing the game that
  // just ended) or an older game revisited later via the accordion once a
  // later game is live. Previously this only covered the "revisit an
  // older game" case and returned "default" (pregame hype graphics)
  // instead — meaning the game that just finished had its Scoreboard/
  // Objectives/Draft recap yanked the instant it ended, and switching
  // back to it via the accordion showed the same hype graphics again
  // instead of its actual result. A finished game's own data should never
  // be reachable-but-hidden like that.
  if (selectedGame && selectedGame.status === "finished") return "finished";
  if (state === "DRAFT_STARTED" || state === "DRAFT_COMPLETE") return "draft";
  if (state === "MATCH_NOT_STARTED" || state === "GAME_FINISHED") return "default";
  return "game";
}
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
  player: { ign: string; role: string | null; team_id: string; is_active_roster: boolean } | null;
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
// dark_theme is YouTube's own embed param — without it the chat iframe
// picks its own default regardless of what theme Livevival is in, which
// read as broken/unreadable whenever the two disagreed (light page, dark
// chat or vice versa). Tied directly to the same theme state driving the
// rest of this page instead of guessing at the viewer's YouTube settings.
function youtubeChatEmbedUrl(url: string | null, isDark: boolean) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  if (!idMatch) return null;
  const domain = typeof window !== "undefined" ? window.location.hostname : "livevival-sigma.vercel.app";
  return `https://www.youtube.com/live_chat?v=${idMatch[1]}&embed_domain=${domain}${isDark ? "&dark_theme=1" : ""}`;
}

// Public-page-only "hero portraits replace player avatars, top to bottom,
// as picks land" board (the Draft-bucket "Draft BIG" requirement). Built
// directly in this file rather than by touching the shared
// components/DraftOverlay.tsx (also imported by the admin live console,
// owned by a different concurrent agent) — this keeps the same broadcast
// idea (swap a player's avatar for their hero's icon once it locks in,
// keep the name label) without risking any behavior change for that other
// caller.
//
// hero_picks_bans rows never carry a real player_id while a draft is
// actually in progress (the admin's draft simulation logs `player_id:
// null` for every step — see logSimulationStep in the live console — and
// only assigns real players after the fact, once DRAFT_COMPLETE). So there
// is no reliable "this exact player picked this exact hero" signal to key
// off while picks are landing live. Instead this positionally maps each
// team's Nth completed pick (ordered by pick_order) onto the Nth roster
// player in the same fixed top-to-bottom role order every other draft
// view on this page already sorts by (ROLE_ORDER/roleIndex) — so slots
// fill top-to-bottom in real time as picks come in, one at a time, exactly
// as they're logged, without waiting for a post-draft assignment step.
function PublicPlayerAvatar({ url, name }: { url: string | null | undefined; name: string }) {
  if (!url) {
    const initials = name.trim().slice(0, 2).toUpperCase();
    return (
      <span className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 shrink-0 flex items-center justify-center text-white/30 font-display font-bold text-xs">
        {initials || "?"}
      </span>
    );
  }
  return (
    <span className="w-10 h-10 rounded-lg overflow-hidden border border-white/10 shrink-0 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={name} className="w-full h-full object-cover object-top" />
    </span>
  );
}

function PublicDraftTeamPanel({
  teamName,
  logoUrl,
  roster,
  picksAndBans,
  onClock,
}: {
  teamName: string | null | undefined;
  logoUrl: string | null | undefined;
  roster: RosterPlayer[];
  picksAndBans: PickBan[];
  onClock: boolean;
}) {
  const sortedRoster = [...roster].sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
  const picks = picksAndBans.filter((p) => p.type === "pick").sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  const bans = picksAndBans.filter((p) => p.type === "ban").sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  return (
    <div
      className={`lv-card-flush p-3 sm:p-4 space-y-3 transition-colors duration-300 ${
        onClock ? "border-signal/50 ring-1 ring-signal/40 bg-signal/5" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-white/80 font-semibold text-sm flex items-center gap-2 min-w-0">
          <TeamLogo url={logoUrl} size="sm" />
          <span className="truncate">{teamName}</span>
        </p>
      </div>
      <div className="space-y-2">
        {sortedRoster.length === 0 ? (
          <p className="text-xs text-white/30">Roster not confirmed yet.</p>
        ) : (
          sortedRoster.map((p, i) => {
            // Top-to-bottom positional match: this team's i-th roster slot
            // (in role order) gets this team's i-th locked-in pick (in pick
            // order) — see the function comment above for why player_id
            // itself can't be used here.
            const pick = picks[i];
            return (
              <div key={p.id} className="flex items-center gap-3">
                {pick ? (
                  <HeroIcon url={pick.hero?.icon_url} name={pick.hero_name} size="sm" />
                ) : (
                  <PublicPlayerAvatar url={p.photo_url} name={p.ign} />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{p.ign}</p>
                  <p className="text-[10px] text-white/40 uppercase tracking-wide truncate">{pick ? pick.hero_name : p.role ?? "—"}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
      {bans.length > 0 && (
        <div className="flex items-center gap-1.5 pt-2 border-t border-white/10 flex-wrap">
          <span className="text-[9px] uppercase tracking-wide text-white/30 mr-1">Bans</span>
          {bans.map((b) => (
            <HeroIcon key={b.id} url={b.hero?.icon_url} name={b.hero_name} size="xs" banned />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PublicMatchPage() {
  const params = useParams();
  const matchId = params.id as string;
  const { theme, resolvedTheme } = useTheme();
  const isDarkTheme = (resolvedTheme ?? theme) === "dark";

  const [match, setMatch] = useState<Match | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [pickBans, setPickBans] = useState<PickBan[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  // Scrolls the moment list to its newest (bottom-most, since the list
  // itself reads oldest-to-newest top-to-bottom) entry on every update —
  // without this, a fixed-height scroll box with a chat-log reading order
  // would silently need a manual scroll down every time something new
  // logs, defeating the point of putting the newest entry at the bottom.
  const momentListRef = useRef<HTMLDivElement | null>(null);
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
  // Video size mode — Small (default: full-width stream, everything
  // stacked below it, today's behavior) / Theater (50:50 split, stats
  // move beside the stream) / Big (70:30, stream dominant). Persisted so
  // a viewer's choice survives a reload.
  const [videoSize, setVideoSize] = useState<"small" | "theater" | "big">("small");
  useEffect(() => {
    const saved = localStorage.getItem("lv-public-video-size");
    if (saved === "small" || saved === "theater" || saved === "big") setVideoSize(saved);
  }, []);
  function applyVideoSize(size: "small" | "theater" | "big") {
    setVideoSize(size);
    localStorage.setItem("lv-public-video-size", size);
  }
  const [recapRefreshKey, setRecapRefreshKey] = useState(0);

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
        `id, status, state, custom_state_label, format, youtube_url, series_winner_team_id, update_source, notification_tier, scheduled_at,
         countdown_seconds, countdown_updated_at,
         tournament:tournaments(name, tier, liquipedia_slug),
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
          "id, game_id, player_id, hero_name, kills, deaths, assists, gold, player:players(ign, role, team_id, is_active_roster), hero:heroes(icon_url)"
        )
        .eq("match_id", matchId),
      supabase.from("objectives").select("id, game_id, team_id, type, minute_mark").eq("match_id", matchId).order("minute_mark"),
      supabase
        .from("key_moments")
        .select("id, game_id, type, description, minute_mark, second_mark, created_at, player:players(ign), screenshot_url, source, is_key_moment")
        .eq("match_id", matchId)
        .order("created_at", { ascending: true }),
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

  // Coalesces bursts of realtime events into one loadAll() call instead of
  // one per event. A Hot match's OCR capture ticks every 5s and writes to
  // net_worth_snapshots/player_stats on most of those ticks, and a single
  // admin action (e.g. logging a pick) can touch more than one of the 8
  // subscribed tables at once — without this, that's a full 9-query reload
  // fired repeatedly, sometimes several in-flight at once, for the entire
  // duration of a live match, for every concurrent viewer. Leading-ish
  // debounce (short quiet window) so one isolated event still updates
  // promptly, with a floor on how close together two reloads can land so a
  // sustained burst settles into "about once every ~2.5s" instead of
  // "once per event."
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReloadAtRef = useRef(0);
  const scheduleReload = useCallback(() => {
    if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current);
    const DEBOUNCE_MS = 400;
    const MIN_GAP_MS = 2500;
    const sinceLastReload = Date.now() - lastReloadAtRef.current;
    const wait = Math.max(DEBOUNCE_MS, MIN_GAP_MS - sinceLastReload);
    reloadTimeoutRef.current = setTimeout(() => {
      lastReloadAtRef.current = Date.now();
      loadAll();
    }, wait);
  }, [loadAll]);

  useEffect(() => {
    loadAll();
    lastReloadAtRef.current = Date.now();

    const channel = supabase
      .channel(`match-${matchId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "hero_picks_bans", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_stats", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "objectives", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "key_moments", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "net_worth_snapshots", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "game_screenshots", filter: `match_id=eq.${matchId}` }, scheduleReload)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current);
    };
  }, [matchId, loadAll, scheduleReload]);

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

  useEffect(() => {
    const el = momentListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [keyMoments.length]);

  if (loadError) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center text-sm gap-2 px-6 text-center">
        <p className="text-red-400">Couldn&apos;t load this match: {loadError}</p>
        <a href="/" className="lv-nav-link">Back to homepage</a>
      </main>
    );
  }
  if (!match) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  // Drives which of the four layouts renders below — recomputed on every
  // render straight from match.state (itself kept fresh by the Realtime
  // subscription above), so a state transition reflows the page the moment
  // the row changes with no reload and no separate effect to keep in sync.
  const selectedGame = games.find((g) => g.id === selectedGameId) ?? null;
  const liveGameId = games.find((g) => g.status !== "finished")?.id ?? games[games.length - 1]?.id ?? null;
  const layoutBucket = layoutBucketFor(match.state, selectedGame, liveGameId);

  const teamAId = match.team_a?.id;
  const teamBId = match.team_b?.id;

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
  const chatEmbedUrl = youtubeChatEmbedUrl(match.youtube_url, isDarkTheme);

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
  type ScoreRow = { id: string; ign: string; role: string | null; heroIconUrl: string | null; heroName: string | null; kills: number | null; deaths: number | null; assists: number | null };
  function scoreRowsFor(stats: PlayerStat[], activeRoster: RosterPlayer[]): ScoreRow[] {
    if (stats.length > 0) {
      return stats.map((s) => ({
        id: s.id,
        ign: s.player?.ign ?? "?",
        role: s.player?.role ?? null,
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
      .map((p) => ({ id: p.id, ign: p.ign, role: p.role, heroIconUrl: null, heroName: null, kills: null, deaths: null, assists: null }));
  }
  const teamABans = gamePickBans.filter((p) => p.team_id === teamAId && p.type === "ban");
  const teamAPicks = gamePickBans
    .filter((p) => p.team_id === teamAId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));
  const teamBBans = gamePickBans.filter((p) => p.team_id === teamBId && p.type === "ban");
  const teamBPicks = gamePickBans
    .filter((p) => p.team_id === teamBId && p.type === "pick")
    .sort((a, b) => roleIndex(a.player?.role) - roleIndex(b.player?.role));

  // Last-captured net worth reading for the selected game — a raw text
  // readout (see formatGold below), not a recomputed/derived value. Rows
  // are ordered by minute_mark ascending (see the query above), so the
  // last one is simply whatever the tracker read most recently; a bad OCR
  // read on the admin side never inserts a row at all (see the admin live
  // console's captureTickBody), so this naturally keeps showing the last
  // known-good value instead of blanking or showing junk.
  const latestNetWorth = gameNetWorth[gameNetWorth.length - 1] ?? null;
  function formatGold(n: number): string {
    return `${(n / 1000).toFixed(1)}K`;
  }

  // "Momentum" bar — a rough, clearly-labeled lean indicator built purely
  // from data this page already fetches for a live game: the latest net
  // worth snapshot and each team's current kill count. No new querying or
  // tracking, no real win-probability modelling — just enough signal to
  // answer "who's ahead right now" at a glance. Net worth is weighted
  // higher (0.65) since it updates continuously through the game; kills
  // move in coarser, streakier jumps so count for less (0.35). Only shown
  // once the game is actually live AND a net worth snapshot exists — Normal
  // matches (Liquipedia-sourced, no OCR) never get net worth data, so this
  // stays hidden for them rather than rendering an empty/fake bar.
  const showMomentum = match.state === "GAME_STARTED" && latestNetWorth != null;
  let momentumTeamAPct = 50;
  if (showMomentum && latestNetWorth) {
    const goldTotal = latestNetWorth.team_a_gold + latestNetWorth.team_b_gold;
    const goldLean = goldTotal > 0 ? (latestNetWorth.team_a_gold - latestNetWorth.team_b_gold) / goldTotal : 0;
    const killTotal = teamAKills + teamBKills;
    const killLean = killTotal > 0 ? (teamAKills - teamBKills) / killTotal : 0;
    const lean = Math.max(-1, Math.min(1, goldLean * 0.65 + killLean * 0.35));
    // Clamped to 8-92% so the trailing side's sliver never fully vanishes —
    // this is a rough lean, not a precise probability split.
    momentumTeamAPct = Math.max(8, Math.min(92, 50 + lean * 50));
  }
  // Explicit numeric "Win %" figure on top of the same bar/calc above —
  // whichever side the lean currently favors, expressed as "62% — Team A"
  // rather than making people read bar-width by eye. Still the same rough
  // lean, still clearly labeled as an estimate; no new modelling.
  const momentumLeaderIsA = momentumTeamAPct >= 50;
  const momentumLeaderPct = Math.round(momentumLeaderIsA ? momentumTeamAPct : 100 - momentumTeamAPct);
  const momentumLeaderName = momentumLeaderIsA ? match.team_a?.name : match.team_b?.name;

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
  // A match can be "finished" with a real series winner even though no game
  // ever recorded one (a walkover/withdrawal) — games.winner_team_id-derived
  // counts can't tell "not started" apart from "decided without being
  // played", so this checks the one signal that can.
  const isForfeitWin = match.status === "finished" && Boolean(match.series_winner_team_id) && gamesWonByA === 0 && gamesWonByB === 0;

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
        const res = await fetch(`/api/recap-card/${match?.id}?ratio=${recapRatio}&t=${recapRefreshKey}`);
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
    <main className="min-h-screen bg-ink text-paper px-6 py-8 max-w-7xl mx-auto space-y-8">
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
        <p className="text-xs text-white/50 uppercase tracking-wide">
          {match.tournament?.liquipedia_slug ? (
            <a href={`/tournaments/${match.tournament.liquipedia_slug}`} className="hover:text-white underline">
              {match.tournament?.name}
            </a>
          ) : (
            match.tournament?.name
          )}{" "}
          · {match.tournament?.tier}-Tier · {match.format}
          {match.scheduled_at ? ` · ${formatMatchDate(match.scheduled_at)}` : ""}
        </p>
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
              {isForfeitWin ? (
                <>
                  <span className={seriesWinnerTeamId === teamAId ? "text-signal" : "text-paper"}>{seriesWinnerTeamId === teamAId ? "W" : "L"}</span>
                  <span className="text-white/20 text-2xl sm:text-4xl">–</span>
                  <span className={seriesWinnerTeamId === teamBId ? "text-signal" : "text-paper"}>{seriesWinnerTeamId === teamBId ? "W" : "L"}</span>
                </>
              ) : games.length > 0 ? (
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
          {/* "Whose turn" itself (draftTurnTeamId, derived from actual
              pick/ban counts) is shown as a highlighted border on that
              team's own draft panel below — no separate timer badge here
              anymore. The old one read from draft_timer_a_seconds/
              b_seconds, which the admin console stopped writing to (see
              its own comment on that decision) — it would've frozen or
              counted into negative numbers on any older match instead of
              showing something real. */}
          {match.update_source === "local_ocr" && (
            <span
              className="lv-badge bg-signal/20 text-signal border border-signal/40"
              title="Fully admin-tracked: live KDA, items, and moment log"
            >
              🔥 HOT
            </span>
          )}
          {/* notification_tier badge — separate axis from update_source
              above (see the migration comment). Hot only shows its own
              badge here when it disagrees with update_source, to avoid
              repeating the 🔥 HOT badge. */}
          {match.notification_tier === "priority" && (
            <span
              className="lv-badge bg-amber-400/20 text-amber-300 border border-amber-400/40"
              title="Priority notifications: automatic match-started and match-finished alerts"
            >
              🔔 PRIORITY
            </span>
          )}
          {match.notification_tier === "hot" && match.update_source !== "local_ocr" && (
            <span
              className="lv-badge bg-signal/20 text-signal border border-signal/40"
              title="Hot notification tier: full automatic Telegram/Slack alerts"
            >
              🔥 HOT ALERTS
            </span>
          )}
          {match.status === "live" && (
            <span className="lv-badge bg-white/10 text-white/60 tabular-nums" title="People currently on this page">
              👀 {watchingNow} watching
            </span>
          )}
          <FollowButton entityType="match" entityId={matchId} />
        </div>

        {isForfeitWin && seriesWinnerName && (
          <p className="lv-alert-warning">🟥 {seriesWinnerName} win by default — this match was decided without any games being played.</p>
        )}

        {mvp && (
          <p className="text-sm text-white/70">
            Game {selectedGame?.game_number} MVP: {mvp.player?.ign} ({mvp.hero_name}) — {mvp.kills ?? "TBD"}/{mvp.deaths ?? "TBD"}/{mvp.assists ?? "TBD"}
          </p>
        )}
      </header>

      {/* Video size — Small keeps the single-column flow below exactly as
          it's always worked (sticky stream, everything stacked
          underneath). Theater/Big instead split the page into two columns
          at lg+ (video left, every stats section to its right, in its own
          independently-scrolling column) — see the grid wrapper right
          below this toggle. */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Video size</span>
        {(["small", "theater", "big"] as const).map((size) => (
          <button
            key={size}
            onClick={() => applyVideoSize(size)}
            className={`text-xs px-2.5 py-1 rounded border capitalize transition-colors ${
              videoSize === size ? "border-signal bg-signal/20 text-signal" : "border-white/10 text-white/50 hover:bg-white/5"
            }`}
          >
            {size}
          </button>
        ))}
      </div>

      <div
        className={
          videoSize === "small"
            ? "space-y-8"
            : `lg:grid gap-6 items-start ${videoSize === "theater" ? "lg:grid-cols-[1fr_1fr]" : "lg:grid-cols-[7fr_3fr]"}`
        }
      >
      {/* Sticky "theater mode" — stays pinned to the top of the viewport
          while everything below (moments, draft recap, stats, etc.)
          scrolls underneath it, instead of scrolling the stream itself
          out of view. A single-column sticky element does this on its
          own (no grid split needed): it sticks in place once its natural
          scroll position reaches `top`, and stays stuck because nothing
          shorter constrains it — the rest of the page just keeps scrolling
          past below. bg-ink covers the seam so nothing shows through. In
          Theater/Big mode this is the grid's left column instead of the
          full page width — still sticky, now within that column. */}
      <div className={`sticky top-0 z-10 bg-ink pt-2 pb-3 space-y-2 ${videoSize !== "small" ? "lg:self-start" : ""}`}>
        {/* Once at least one game is decided, the switcher reads as a
            recap accordion (▶ collapsed / ▼ expanded row per game) instead
            of a plain pill row — same underlying selectedGameId toggle
            (only one game's sections render below at a time, see the
            Draft recap/Scoreboard/Screenshots sections further down), just
            framed as "which game's recap is open" rather than "which tab
            is active". Kept as compact pills during an in-progress Draft
            or Game, where a vertical accordion would just eat space above
            the stream for no benefit. */}
        {games.length > 1 && (layoutBucket === "finished" || layoutBucket === "default") ? (
          <div className="flex flex-col gap-1.5">
            {games.map((g) => {
              const expanded = selectedGameId === g.id;
              const winnerName = g.winner_team_id === teamAId ? match.team_a?.name : g.winner_team_id === teamBId ? match.team_b?.name : null;
              return (
                <button
                  key={g.id}
                  onClick={() => setSelectedGameId(g.id)}
                  aria-expanded={expanded}
                  className={`text-left text-xs px-3 py-2 rounded-md border flex items-center gap-2 transition-all duration-200 ${
                    expanded
                      ? "bg-signal/15 border-signal shadow-[0_0_16px_1px_rgba(232,72,58,0.25)]"
                      : "border-white/10 hover:border-signal/40 hover:bg-white/5"
                  }`}
                >
                  <span className="shrink-0">{expanded ? "▼" : "▶"}</span>
                  <span className="font-semibold">Game {g.game_number}</span>
                  <span className="text-white/60">
                    {winnerName
                      ? `Recap — ${winnerName} won`
                      : g.id === liveGameId && match.state !== "SERIES_FINISHED"
                      ? "In progress…"
                      : "Not started yet"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          games.length > 1 && (
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
          )
        )}

        {/* Video always full width, same treatment across every phase —
            chat is a floating toggle + overlay panel instead of a second
            flex column, so opening it never shrinks or reflows the video
            underneath ("without interfere the watching experience"). One
            block for every layoutBucket instead of two near-identical
            copies (draft used to reorder chat before video and give it a
            permanent — if empty — 2/5 column even while closed). */}
        <div className="max-w-5xl mx-auto relative">
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
          {chatEmbedUrl && (
            <button
              onClick={() => setChatOpen((v) => !v)}
              aria-expanded={chatOpen}
              className="absolute top-2 right-2 z-10 text-xs rounded-full px-3 py-1.5 bg-black/60 backdrop-blur border border-white/20 text-white hover:bg-black/80 shadow"
            >
              💬 {chatOpen ? "Hide chat" : "Chat"}
            </button>
          )}
        </div>

        {/* Overlay, not a layout column — a backdrop + slide-in panel on
            desktop (fixed to the viewport edge) that sits on TOP of the
            page, and a bottom sheet on mobile. Either way the video's own
            size never changes when this opens or closes. */}
        {chatEmbedUrl && chatOpen && (
          <>
            <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setChatOpen(false)} aria-hidden="true" />
            <div className="fixed z-40 bottom-0 left-0 right-0 h-[70vh] sm:h-auto sm:top-0 sm:bottom-0 sm:right-0 sm:left-auto sm:w-[360px] sm:max-w-[90vw] flex flex-col bg-ink border-t sm:border-t-0 sm:border-l border-white/10 shadow-2xl">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
                <span className="text-sm font-semibold">Live chat</span>
                <button onClick={() => setChatOpen(false)} className="text-white/50 hover:text-white text-sm" aria-label="Close chat">
                  ✕
                </button>
              </div>
              <iframe
                src={chatEmbedUrl}
                className={`w-full flex-1 min-h-0 ${isDarkTheme ? "bg-black/50" : "bg-white/50"}`}
                title="YouTube live chat"
              />
            </div>
          </>
        )}
      </div>

      {/* Theater/Big mode's right column — every stats section from here
          down to the end of the page, in its own independently-scrolling
          box instead of the page's own scroll. Small mode gets the exact
          same wrapper with different classes (space-y-8, no height/scroll
          constraint) rather than a second copy of this markup, so there's
          one JSX tree either way — just restyled per mode. */}
      <div className={videoSize === "small" ? "space-y-8" : "space-y-8 lg:max-h-screen lg:overflow-y-auto lg:pr-1"}>
      {match.update_source === "local_ocr" && (
        <section>
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            {/* "Moment list" during Draft/Game, "Timeline" once the series
                is done — same underlying feed, per-bucket framing only. */}
            <h2 className="lv-heading">{layoutBucket === "finished" ? "Timeline" : "Moment list"}</h2>
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
          {/* Reads top-to-bottom like a chat log — oldest first, newest at
              the bottom (query is sorted created_at asc) — with the box
              auto-scrolled to the newest entry on every update (see the
              momentListRef effect below), so a viewer never has to
              manually scroll down to see what just happened. Draft layout
              keeps this deliberately small ("Moment list small" per spec)
              since the Draft board above is the star there; Finished gets
              more room as a proper Timeline replay. */}
          <div
            ref={momentListRef}
            className={`space-y-2 overflow-y-auto pr-1 ${
              layoutBucket === "draft" ? "max-h-[220px]" : layoutBucket === "finished" ? "max-h-[640px]" : "max-h-[420px]"
            }`}
          >
            {keyMoments.map((km, i) => {
              // Sorted oldest-first, so a separator belongs above the
              // first moment of each game — wherever the game_id changes
              // from the previous (chronologically earlier) entry above it.
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

      {/* Draft bucket ("During Draft: Video / Draft BIG / Moment list small
          / No scoreboard") — the public hero-portrait board, prominent
          and right under the video, replacing both the Map line and the
          standard-size Draft recap below for this bucket. See
          PublicDraftTeamPanel above for why this can't key off player_id. */}
      {layoutBucket === "draft" && (
        <section>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="lv-heading">Draft {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
            {match.state === "DRAFT_STARTED" && <span className="text-xs text-white/50">Picks lock in live, top to bottom.</span>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <PublicDraftTeamPanel
              teamName={match.team_a?.name}
              logoUrl={match.team_a?.logo_url}
              roster={teamAActiveRoster.length > 0 ? teamAActiveRoster : roster.filter((p) => p.team_id === teamAId)}
              picksAndBans={gamePickBans.filter((p) => p.team_id === teamAId)}
              onClock={Boolean(draftTurnTeamId) && draftTurnTeamId === teamAId}
            />
            <PublicDraftTeamPanel
              teamName={match.team_b?.name}
              logoUrl={match.team_b?.logo_url}
              roster={teamBActiveRoster.length > 0 ? teamBActiveRoster : roster.filter((p) => p.team_id === teamBId)}
              picksAndBans={gamePickBans.filter((p) => p.team_id === teamBId)}
              onClock={Boolean(draftTurnTeamId) && draftTurnTeamId === teamBId}
            />
          </div>
        </section>
      )}

      {layoutBucket !== "draft" && selectedGame?.map && (
        <p className="text-base text-white/50">Map: <span className="text-white/80 font-semibold">{selectedGame.map}</span></p>
      )}

      {/* Net worth over time chart removed — net worth is now a raw
          last-captured-value readout (see the badge on each team's
          Scoreboard card below), not a plotted history. */}

      {/* Standard-size Draft recap: always in the Finished layout, and also
          during Game for matches with no live Scoreboard to show hero picks
          another way (Liquipedia/Normal matches — their Scoreboard-derived
          "Player stats" don't exist, so this is their only hero-pick view
          once Draft's own big board is gone). Skipped during Game for
          local_ocr matches since the Scoreboard's own hero column already
          covers it — no point duplicating the same picks twice. */}
      {(layoutBucket === "finished" || (layoutBucket === "game" && match.update_source !== "local_ocr")) && (
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
      )}

      {match.update_source !== "local_ocr" && layoutBucket !== "draft" && (
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

      {/* Objectives + Scoreboard — the "During Game: ... Scoreboard / Player
          stats" and "Finished: ... Statistics" buckets share this exact
          block (see the dynamic Statistics/Scoreboard heading above);
          hidden entirely during Draft ("No scoreboard" per spec). */}
      {match.update_source === "local_ocr" && (layoutBucket === "game" || layoutBucket === "finished") && (
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
          <h2 className="lv-heading">
            {layoutBucket === "finished" ? "Statistics" : "Scoreboard"} {games.length > 1 && `— Game ${selectedGame?.game_number}`}
          </h2>
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
        {/* Momentum — approximate lean from live net worth + kills only,
            see the derivation above. Deliberately small/muted and labeled
            "rough estimate" so it doesn't read as a precise stat. Now also
            spells out an explicit numeric Win % on the bar itself
            (momentumLeaderPct/momentumLeaderName, derived from the exact
            same momentumTeamAPct calc — no second system) instead of
            leaving it to eyeballing the bar width. */}
        {showMomentum && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-white/40 mb-1">
              <span className="truncate max-w-[30%]">{match.team_a?.name}</span>
              <span className="normal-case tracking-normal shrink-0 px-1 text-center text-white/70">
                {momentumLeaderPct}% — {momentumLeaderName ?? "—"} <span className="text-white/40">· rough estimate</span>
              </span>
              <span className="truncate max-w-[30%] text-right">{match.team_b?.name}</span>
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-white/10" role="img" aria-label={`Momentum lean, approximate: ${Math.round(momentumTeamAPct)}% ${match.team_a?.name ?? "Team A"}, ${Math.round(100 - momentumTeamAPct)}% ${match.team_b?.name ?? "Team B"}`}>
              <div className="bg-signal transition-all duration-500" style={{ width: `${momentumTeamAPct}%` }} />
              <div className="bg-win transition-all duration-500" style={{ width: `${100 - momentumTeamAPct}%` }} />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          {[
            { name: match.team_a?.name, list: scoreRowsFor(teamAStats, teamAActiveRoster), gold: latestNetWorth?.team_a_gold },
            { name: match.team_b?.name, list: scoreRowsFor(teamBStats, teamBActiveRoster), gold: latestNetWorth?.team_b_gold },
          ].map((t, i) => (
            <div key={i} className="lv-card-flush p-4 relative">
              {/* Net worth — last-captured OCR reading, not a
                  recomputed/derived value (see formatGold above). Pinned to
                  this card's top-right corner rather than the old
                  over-time chart. */}
              {t.gold != null && (
                <span
                  className="absolute top-2 right-2 text-[10px] font-mono tabular-nums text-white/60 bg-white/10 border border-white/10 rounded px-1.5 py-0.5"
                  title="Last-captured net worth"
                >
                  {formatGold(t.gold)}
                </span>
              )}
              <p className="text-white/70 font-semibold mb-2 text-sm">{t.name}</p>
              <table className="w-full text-xs">
                <thead className="text-white/40 text-left uppercase tracking-wide">
                  <tr><th className="pb-1.5">Player</th><th className="pb-1.5">Role</th><th className="pb-1.5">Hero</th><th className="pb-1.5">K</th><th className="pb-1.5">D</th><th className="pb-1.5">A</th></tr>
                </thead>
                <tbody>
                  {t.list.map((s) => (
                    <tr key={s.id} className="border-t border-white/10">
                      <td className="py-1.5">{s.ign}</td>
                      <td className="py-1.5 text-white/40 text-[10px] uppercase tracking-wide">{s.role ?? "—"}</td>
                      <td className="flex items-center gap-1.5 py-1.5">
                        {s.heroIconUrl && <HeroIcon url={s.heroIconUrl} name={s.heroName} size="xs" />}
                        {s.heroName ?? (s.heroIconUrl === null && s.heroName === null ? "—" : "")}
                      </td>
                      <td className="tabular-nums">{s.kills !== null ? s.kills : <span className="text-white/30">0</span>}</td>
                      <td className="tabular-nums">{s.deaths !== null ? s.deaths : <span className="text-white/30">0</span>}</td>
                      <td className="tabular-nums">{s.assists !== null ? s.assists : <span className="text-white/30">0</span>}</td>
                    </tr>
                  ))}
                  {t.list.length === 0 && (
                    <tr><td colSpan={6} className="py-2 text-white/30">No stats yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        {/* Only in the During-Game layout — this is about the live read,
            not the finished/"Statistics" replay of the same table. */}
        {layoutBucket === "game" && (
          <p className="text-[10px] text-white/35 italic text-center mt-3">
            This match is covered using a manual vision tracker. Numbers might not be accurate. We will keep improving our system for better data.
          </p>
        )}
      </section>
      </>
      )}

      {/* Screenshots — shown during game state and finished state. During
          game, displays auto-updating gallery as captures come in; finished
          state shows post-series highlights reel. Individual key moments
          still carry their own inline screenshot in the Moment list above. */}
      {match.update_source === "local_ocr" && (layoutBucket === "game" || layoutBucket === "finished") && gameScreenshots.length > 0 && (
      <section>
        <h2 className="lv-heading mb-2">Screenshots {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="overflow-x-auto pr-2">
          <div className="flex gap-3 pb-2">
            {gameScreenshots.map((s) => (
              <div key={s.id} className="flex-shrink-0 w-48 space-y-1">
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
                  <img src={s.image_url} alt="" className="w-full rounded-md border border-white/10 aspect-video object-cover" />
                </button>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-white/40 truncate">
                    {s.in_game_time ? `${s.in_game_time}` : ""}
                  </p>
                  <a href={s.image_url} download className="text-[10px] text-white/50 hover:text-signal shrink-0">
                    ⬇
                  </a>
                </div>
                {s.note && <p className="text-[10px] text-white/50 line-clamp-2">{s.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>
      )}

      {/* Screenshots empty state for finished matches that have no shots */}
      {match.update_source === "local_ocr" && layoutBucket === "finished" && gameScreenshots.length === 0 && (
      <section>
        <h2 className="lv-heading mb-2">Screenshots {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <span className="text-white/30 text-xs">No screenshots captured.</span>
      </section>
      )}

      {/* Pick/ban order — during an ongoing Hot match, this used to be
          skipped entirely (the Live Scoreboard's own hero column already
          shows who picked what, so a full recap felt redundant) but that
          meant ban order specifically was never visible anywhere during
          gameplay, only before or after it. Collapsed and bottom-most
          instead of removed — reachable, not competing with the live
          scoreboard above for attention. */}
      {match.update_source === "local_ocr" && layoutBucket === "game" && (
        <details className="group">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden lv-heading mb-3 flex items-center gap-1.5">
            <span className="text-white/40 text-sm transition-transform group-open:rotate-90">▸</span>
            Pick &amp; ban order {games.length > 1 && `— Game ${selectedGame?.game_number}`}
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            {[
              { name: match.team_a?.name, bans: teamABans, picks: teamAPicks },
              { name: match.team_b?.name, bans: teamBBans, picks: teamBPicks },
            ].map((t, i) => (
              <div key={i} className="lv-card-flush p-4 space-y-3">
                <p className="text-white/70 font-semibold">{t.name}</p>
                <div className="rounded-lg border border-white/10 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-white/40">Picks</p>
                  <div className="flex flex-wrap gap-3">
                    {t.picks.map((p) => (
                      <div key={p.id} className="flex flex-col items-center gap-1 w-14">
                        <HeroIcon url={p.hero?.icon_url} name={p.hero_name} size="md" />
                        <span className="text-[10px] text-white/70 text-center leading-tight truncate w-full">{p.hero_name}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 p-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-white/40">Bans</p>
                  <div className="flex flex-wrap gap-3">
                    {t.bans.map((b) => (
                      <div key={b.id} className="flex flex-col items-center gap-1 w-12">
                        <HeroIcon url={b.hero?.icon_url} name={b.hero_name} size="sm" banned />
                        <span className="text-[9px] text-white/40 text-center leading-tight truncate w-full">{b.hero_name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      </div>
      </div>

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

      {/* Same layoutBucket as everything else above (SERIES_FINISHED),
          rather than the separate match.status field — the two are always
          set together by the admin's "finish match" actions, but driving
          this off match.state too keeps the whole page reacting to one
          single source of truth for "which layout is this". */}
      {layoutBucket === "finished" && (
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
                key={recapRefreshKey}
                src={`/api/recap-card/${match.id}?ratio=${recapRatio}&t=${recapRefreshKey}`}
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
                  href={`/api/recap-card/${match.id}?ratio=${recapRatio}&t=${recapRefreshKey}`}
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
                <button
                  onClick={() => setRecapRefreshKey((k) => k + 1)}
                  className="px-3 py-1.5 rounded border border-white/10 text-white/50 hover:bg-white/5"
                  title="Regenerate recap image with latest data"
                >
                  🔄 Refresh
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
              key={recapRefreshKey}
              src={`/api/recap-card/${match.id}?ratio=${recapRatio}&t=${recapRefreshKey}`}
              alt="Match recap card preview"
              className="w-full rounded lv-card-flush"
            />
            <div className="flex flex-wrap gap-2 justify-center">
              <a
                href={`/api/recap-card/${match.id}?ratio=${recapRatio}&t=${recapRefreshKey}`}
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
