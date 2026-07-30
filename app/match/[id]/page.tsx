"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

type Match = {
  id: string;
  status: string;
  format: string | null;
  youtube_url: string | null;
  tournament: { name: string; tier: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type Game = { id: string; game_number: number; status: string };
type PickBan = { id: string; team_id: string; hero_name: string; type: "pick" | "ban"; pick_order: number | null };
type PlayerStat = {
  id: string;
  player_id: string;
  hero_name: string | null;
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  player: { ign: string; team_id: string } | null;
};
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null };
type KeyMoment = {
  id: string;
  type: string;
  minute_mark: number | null;
  player: { ign: string } | null;
  screenshot_url: string | null;
  source: string;
};
type NetWorthPoint = { minute_mark: number; team_a_gold: number; team_b_gold: number };

function youtubeEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return idMatch ? `https://www.youtube.com/embed/${idMatch[1]}` : null;
}

export default function PublicMatchPage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [pickBans, setPickBans] = useState<PickBan[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthPoint[]>([]);

  const loadAll = useCallback(async () => {
    const { data: matchData } = await supabase
      .from("matches")
      .select(
        `id, status, format, youtube_url,
         tournament:tournaments(name, tier),
         team_a:teams!matches_team_a_id_fkey(id, name),
         team_b:teams!matches_team_b_id_fkey(id, name)`
      )
      .eq("id", matchId)
      .single();
    if (!matchData) return;
    setMatch(matchData as unknown as Match);

    const { data: gameRow } = await supabase
      .from("games")
      .select("id, game_number, status")
      .eq("match_id", matchId)
      .order("game_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!gameRow) return;
    setGame(gameRow as Game);

    const gid = (gameRow as Game).id;
    const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: nw }] = await Promise.all([
      supabase.from("hero_picks_bans").select("id, team_id, hero_name, type, pick_order").eq("game_id", gid).order("pick_order"),
      supabase.from("player_stats").select("id, player_id, hero_name, kills, deaths, assists, gold, player:players(ign, team_id)").eq("game_id", gid),
      supabase.from("objectives").select("id, team_id, type, minute_mark").eq("game_id", gid).order("minute_mark"),
      supabase.from("key_moments").select("id, type, minute_mark, player:players(ign), screenshot_url, source").eq("game_id", gid).order("minute_mark"),
      supabase.from("net_worth_snapshots").select("minute_mark, team_a_gold, team_b_gold").eq("game_id", gid).order("minute_mark"),
    ]);
    setPickBans((pb as PickBan[]) ?? []);
    setStats((ps as unknown as PlayerStat[]) ?? []);
    setObjectives((obj as Objective[]) ?? []);
    setKeyMoments((km as unknown as KeyMoment[]) ?? []);
    setNetWorth((nw as NetWorthPoint[]) ?? []);
  }, [matchId]);

  useEffect(() => {
    loadAll();

    const channel = supabase
      .channel(`match-${matchId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "hero_picks_bans" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "player_stats" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "objectives" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "key_moments" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "net_worth_snapshots" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, loadAll)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, loadAll]);

  if (!match) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  const embedUrl = youtubeEmbedUrl(match.youtube_url);
  const teamAId = match.team_a?.id;
  const teamBId = match.team_b?.id;
  const teamAStats = stats.filter((s) => s.player?.team_id === teamAId);
  const teamBStats = stats.filter((s) => s.player?.team_id === teamBId);
  const teamABans = pickBans.filter((p) => p.team_id === teamAId && p.type === "ban");
  const teamAPicks = pickBans.filter((p) => p.team_id === teamAId && p.type === "pick");
  const teamBBans = pickBans.filter((p) => p.team_id === teamBId && p.type === "ban");
  const teamBPicks = pickBans.filter((p) => p.team_id === teamBId && p.type === "pick");

  const chartData = netWorth.map((n) => ({
    minute: n.minute_mark,
    diff: n.team_a_gold - n.team_b_gold,
  }));

  const mvp =
    match.status === "finished" && stats.length > 0
      ? [...stats].sort((a, b) => (b.kills + b.assists - b.deaths) - (a.kills + a.assists - a.deaths))[0]
      : null;

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-8 max-w-5xl mx-auto space-y-8">
      <header className="space-y-1">
        <p className="text-xs text-white/50">{match.tournament?.name} · {match.tournament?.tier}-Tier · {match.format}</p>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{match.team_a?.name} vs {match.team_b?.name}</h1>
          <span
            className={`text-xs px-2 py-1 rounded uppercase tracking-wide ${
              match.status === "live" ? "bg-emerald-500/20 text-emerald-400" : "bg-white/10 text-white/50"
            }`}
          >
            {match.status}
          </span>
        </div>
        {mvp && (
          <p className="text-sm text-signal font-semibold">
            🏆 MVP: {mvp.player?.ign} ({mvp.hero_name}) — {mvp.kills}/{mvp.deaths}/{mvp.assists}
          </p>
        )}
      </header>

      {embedUrl && (
        <iframe src={embedUrl} className="w-full aspect-video rounded" allow="autoplay; encrypted-media" allowFullScreen />
      )}

      {chartData.length > 1 && (
        <section>
          <h2 className="font-bold mb-2">Net worth difference</h2>
          <p className="text-xs text-white/50 mb-2">Positive = {match.team_a?.name} ahead. Negative = {match.team_b?.name} ahead.</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff15" />
              <XAxis dataKey="minute" stroke="#ffffff60" tick={{ fontSize: 12 }} label={{ value: "minute", position: "insideBottom", fill: "#ffffff60", fontSize: 11, dy: 10 }} />
              <YAxis stroke="#ffffff60" tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={{ background: "#12141A", border: "1px solid #ffffff20" }} />
              <Line type="monotone" dataKey="diff" stroke="#E8483A" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}

      <section>
        <h2 className="font-bold mb-2">Draft recap</h2>
        <div className="grid grid-cols-2 gap-6 text-sm">
          {[
            { name: match.team_a?.name, bans: teamABans, picks: teamAPicks, teamId: teamAId },
            { name: match.team_b?.name, bans: teamBBans, picks: teamBPicks, teamId: teamBId },
          ].map((t, i) => (
            <div key={i} className="space-y-2">
              <p className="text-white/70 font-semibold">{t.name}</p>
              <p className="text-xs text-white/40">Bans: {t.bans.map((b) => b.hero_name).join(", ") || "—"}</p>
              <div className="text-xs text-white/40 space-y-0.5">
                <p>Picks:</p>
                {t.picks.length === 0 && <p className="pl-2">—</p>}
                {t.picks.map((p) => {
                  const player = stats.find((s) => s.player?.team_id === t.teamId && s.hero_name === p.hero_name);
                  return (
                    <p key={p.id} className="pl-2">
                      {p.hero_name}
                      {player?.player?.ign ? <span className="text-white/60"> — {player.player.ign}</span> : ""}
                    </p>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-bold mb-2">Scoreboard</h2>
        <div className="grid grid-cols-2 gap-6">
          {[
            { name: match.team_a?.name, list: teamAStats },
            { name: match.team_b?.name, list: teamBStats },
          ].map((t, i) => (
            <div key={i}>
              <p className="text-white/70 font-semibold mb-1 text-sm">{t.name}</p>
              <table className="w-full text-xs">
                <thead className="text-white/40 text-left">
                  <tr><th>Player</th><th>Hero</th><th>K/D/A</th><th>Gold</th></tr>
                </thead>
                <tbody>
                  {t.list.map((s) => (
                    <tr key={s.id} className="border-t border-white/10">
                      <td className="py-1">{s.player?.ign}</td>
                      <td>{s.hero_name}</td>
                      <td>{s.kills}/{s.deaths}/{s.assists}</td>
                      <td>{s.gold?.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-bold mb-2">Objectives</h2>
        <div className="flex flex-wrap gap-2 text-xs">
          {objectives.map((o) => (
            <span key={o.id} className="px-2 py-1 rounded bg-white/10 capitalize">
              {o.minute_mark}&apos; {o.type} — {o.team_id === teamAId ? match.team_a?.name : match.team_b?.name}
            </span>
          ))}
          {objectives.length === 0 && <span className="text-white/30">No objectives logged yet.</span>}
        </div>
      </section>

      <section>
        <h2 className="font-bold mb-2">Key moments</h2>
        <div className="flex flex-wrap gap-3">
          {keyMoments.map((km) => (
            <div key={km.id} className="w-40 space-y-1">
              {km.screenshot_url && (
                <img src={km.screenshot_url} alt={km.type} className="w-full rounded border border-white/10" />
              )}
              <span className="text-xs px-2 py-1 rounded bg-signal/20 capitalize inline-block">
                {km.minute_mark}&apos; {km.type.replace("_", " ")}{km.player?.ign ? ` — ${km.player.ign}` : ""}
                {km.source === "auto" && <span className="text-white/40"> · auto</span>}
              </span>
            </div>
          ))}
          {keyMoments.length === 0 && <span className="text-white/30 text-xs">No key moments yet.</span>}
        </div>
      </section>
    </main>
  );
}
