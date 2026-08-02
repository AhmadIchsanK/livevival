"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type Match = {
  id: string;
  status: string;
  format: string | null;
  youtube_url: string | null;
  series_winner_team_id: string | null;
  tournament: { name: string; tier: string } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
  stream: { url: string } | null;
};
type Game = {
  id: string;
  game_number: number;
  status: string;
  state: string;
  winner_team_id: string | null;
  vod_url: string | null;
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
  minute_mark: number | null;
  player: { ign: string } | null;
  screenshot_url: string | null;
  source: string;
};
type NetWorthPoint = { game_id: string; minute_mark: number; team_a_gold: number; team_b_gold: number };

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
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchError } = await supabase
      .from("matches")
      .select(
        `id, status, format, youtube_url, series_winner_team_id,
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
      .select("id, game_number, status, state, winner_team_id, vod_url")
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

    const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: nw }] = await Promise.all([
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
      supabase.from("key_moments").select("id, game_id, type, minute_mark, player:players(ign), screenshot_url, source").eq("match_id", matchId).order("minute_mark"),
      supabase.from("net_worth_snapshots").select("game_id, minute_mark, team_a_gold, team_b_gold").eq("match_id", matchId).order("minute_mark"),
    ]);
    setPickBans((pb as unknown as PickBan[]) ?? []);
    setStats((ps as unknown as PlayerStat[]) ?? []);
    setObjectives((obj as Objective[]) ?? []);
    setKeyMoments((km as unknown as KeyMoment[]) ?? []);
    setNetWorth((nw as NetWorthPoint[]) ?? []);
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
  const videoUrl = selectedGame?.vod_url ?? match.youtube_url ?? match.stream?.url ?? null;
  const embedUrl = youtubeEmbedUrl(videoUrl);

  const gamePickBans = pickBans.filter((p) => p.game_id === selectedGameId);
  const gameStats = stats.filter((s) => s.game_id === selectedGameId);
  const gameObjectives = objectives.filter((o) => o.game_id === selectedGameId);
  const gameKeyMoments = keyMoments.filter((k) => k.game_id === selectedGameId);
  const gameNetWorth = netWorth.filter((n) => n.game_id === selectedGameId);

  const teamAStats = gameStats.filter((s) => s.player?.team_id === teamAId);
  const teamBStats = gameStats.filter((s) => s.player?.team_id === teamBId);
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
  const seriesWinnerName =
    match.series_winner_team_id === teamAId
      ? match.team_a?.name
      : match.series_winner_team_id === teamBId
      ? match.team_b?.name
      : gamesWonByA > gamesWonByB
      ? match.team_a?.name
      : gamesWonByB > gamesWonByA
      ? match.team_b?.name
      : null;

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-8 max-w-5xl mx-auto space-y-8">
      <header className="space-y-1">
        <p className="text-xs text-white/50 uppercase tracking-wide">{match.tournament?.name} · {match.tournament?.tier}-Tier · {match.format}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-display font-light text-2xl sm:text-3xl tracking-tight flex items-center gap-2 flex-wrap">
            {match.team_a?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={proxiedImageUrl(match.team_a.logo_url)} alt="" className="w-8 h-8 rounded object-contain" />
            )}
            {match.team_a?.name} vs {match.team_b?.name}
            {match.team_b?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={proxiedImageUrl(match.team_b.logo_url)} alt="" className="w-8 h-8 rounded object-contain" />
            )}
          </h1>
          <span className={match.status === "live" ? "lv-badge-live" : match.status === "finished" ? "lv-badge-finished" : "lv-badge-scheduled"}>
            {match.status}
          </span>
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
                    {b.hero?.icon_url && <img src={proxiedImageUrl(b.hero.icon_url)} alt="" className="w-4 h-4 rounded-full object-cover grayscale opacity-70" />}
                    {b.hero_name}
                  </span>
                ))}
              </div>
              <div className="text-xs text-white/40 space-y-0.5">
                <p>Picks:</p>
                {t.picks.length === 0 && <p className="pl-2">—</p>}
                {t.picks.map((p) => (
                  <p key={p.id} className="pl-2 flex items-center gap-1.5">
                    {p.hero?.icon_url && <img src={proxiedImageUrl(p.hero.icon_url)} alt="" className="w-5 h-5 rounded-full object-cover" />}
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

      <section>
        <h2 className="lv-heading mb-2">Scoreboard {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="grid grid-cols-2 gap-4">
          {[
            { name: match.team_a?.name, list: teamAStats },
            { name: match.team_b?.name, list: teamBStats },
          ].map((t, i) => (
            <div key={i} className="lv-card-flush p-4">
              <p className="text-white/70 font-semibold mb-2 text-sm">{t.name}</p>
              <table className="w-full text-xs">
                <thead className="text-white/40 text-left uppercase tracking-wide">
                  <tr><th className="pb-1.5">Player</th><th className="pb-1.5">Hero</th><th className="pb-1.5">K/D/A</th><th className="pb-1.5">Gold</th></tr>
                </thead>
                <tbody>
                  {t.list.map((s) => (
                    <tr key={s.id} className="border-t border-white/10">
                      <td className="py-1.5">{s.player?.ign}</td>
                      <td className="flex items-center gap-1.5 py-1.5">
                        {s.hero?.icon_url && <img src={proxiedImageUrl(s.hero.icon_url)} alt="" className="w-5 h-5 rounded-full object-cover" />}
                        {s.hero_name}
                      </td>
                      <td className="tabular-nums">{s.kills}/{s.deaths}/{s.assists}</td>
                      <td className="tabular-nums">{s.gold?.toLocaleString()}</td>
                    </tr>
                  ))}
                  {t.list.length === 0 && (
                    <tr><td colSpan={4} className="py-2 text-white/30">No stats yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="lv-heading mb-2">Objectives {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="flex flex-wrap gap-2 text-xs">
          {gameObjectives.map((o) => (
            <span key={o.id} className="lv-badge bg-white/10 text-white/70 capitalize">
              {o.minute_mark}&apos; {o.type} — {o.team_id === teamAId ? match.team_a?.name : match.team_b?.name}
            </span>
          ))}
          {gameObjectives.length === 0 && <span className="text-white/30">No objectives logged yet.</span>}
        </div>
      </section>

      <section>
        <h2 className="lv-heading mb-2">Key moments {games.length > 1 && `— Game ${selectedGame?.game_number}`}</h2>
        <div className="flex flex-wrap gap-3">
          {gameKeyMoments.map((km) => (
            <div key={km.id} className="w-40 space-y-1.5 lv-card-flush p-2">
              {km.screenshot_url && (
                <img src={km.screenshot_url} alt={km.type} className="w-full rounded-md border border-white/10" />
              )}
              <span className="lv-badge bg-signal/15 text-signal capitalize inline-flex">
                {km.minute_mark}&apos; {km.type.replace("_", " ")}{km.player?.ign ? ` — ${km.player.ign}` : ""}
                {km.source === "auto" && <span className="text-white/40 normal-case tracking-normal font-normal"> · auto</span>}
              </span>
            </div>
          ))}
          {gameKeyMoments.length === 0 && <span className="text-white/30 text-xs">No key moments yet.</span>}
        </div>
      </section>
    </main>
  );
}
