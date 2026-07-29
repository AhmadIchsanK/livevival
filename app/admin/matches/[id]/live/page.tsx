"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Match = {
  id: string;
  youtube_url: string | null;
  format: string | null;
  current_game_number: number;
  tournament: { name: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type Player = { id: string; team_id: string; ign: string; role: string | null };
type Game = { id: string; game_number: number; status: string };
type PickBan = { id: string; team_id: string; hero_name: string; type: "pick" | "ban"; pick_order: number | null };
type PlayerStat = { id: string; player_id: string; hero_name: string | null; kills: number; deaths: number; assists: number; gold: number };
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null };
type KeyMoment = { id: string; type: string; player_id: string | null; minute_mark: number | null };

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
        `id, youtube_url, format, current_game_number,
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
      .select("id, game_number, status")
      .eq("match_id", matchId)
      .eq("game_number", m.current_game_number)
      .maybeSingle();

    if (!gameRow) {
      const { data: created, error: createErr } = await supabase
        .from("games")
        .insert({ match_id: matchId, game_number: m.current_game_number, status: "live" })
        .select("id, game_number, status")
        .single();
      if (createErr) {
        setError(createErr.message);
        return;
      }
      gameRow = created;
    }
    setGame(gameRow as Game);

    const teamIds = [m.team_a?.id, m.team_b?.id].filter(Boolean) as string[];
    const { data: playerRows } = await supabase
      .from("players")
      .select("id, team_id, ign, role")
      .in("team_id", teamIds);
    setPlayers((playerRows as Player[]) ?? []);

    if (gameRow) {
      const gid = (gameRow as Game).id;
      const [{ data: pb }, { data: ps }, { data: obj }, { data: km }] = await Promise.all([
        supabase.from("hero_picks_bans").select("id, team_id, hero_name, type, pick_order").eq("game_id", gid).order("pick_order"),
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
  const [pbTeam, setPbTeam] = useState("");
  const [pbType, setPbType] = useState<"pick" | "ban">("ban");
  const [pbHero, setPbHero] = useState("");
  async function logPickBan() {
    if (!pbTeam || !pbHero || !game) return;
    await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      team_id: pbTeam,
      hero_name: pbHero,
      type: pbType,
      pick_order: pickBans.length + 1,
    });
    setPbHero("");
    loadAll();
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
    if (!game || !match.team_a || !match.team_b) return;
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

  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!match || !game) return <p className="text-white/50 text-sm">Loading match...</p>;

  const embedUrl = youtubeEmbedUrl(match.youtube_url);
  const teamAPlayers = players.filter((p) => p.team_id === match.team_a?.id);
  const teamBPlayers = players.filter((p) => p.team_id === match.team_b?.id);

  return (
    <div className="text-white space-y-8 max-w-6xl">
      <div>
        <h1 className="text-lg font-bold">
          {match.team_a?.name} vs {match.team_b?.name}
        </h1>
        <p className="text-xs text-white/50">{match.tournament?.name} · {match.format} · Game {game.game_number}</p>
      </div>

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
          <button onClick={addPlayer} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
            Add player
          </button>
        </div>
      </section>

      {/* Hero picks/bans */}
      <section className="space-y-3">
        <h2 className="font-bold">Hero picks & bans</h2>
        <div className="flex gap-2 items-end">
          <select value={pbTeam} onChange={(e) => setPbTeam(e.target.value)} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
            <option value="">Team</option>
            {match.team_a && <option value={match.team_a.id}>{match.team_a.name}</option>}
            {match.team_b && <option value={match.team_b.id}>{match.team_b.name}</option>}
          </select>
          <select value={pbType} onChange={(e) => setPbType(e.target.value as "pick" | "ban")} className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm">
            <option value="ban">Ban</option>
            <option value="pick">Pick</option>
          </select>
          <input
            placeholder="Hero name"
            value={pbHero}
            onChange={(e) => setPbHero(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <button onClick={logPickBan} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
            Log
          </button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {pickBans.map((pb) => (
            <span key={pb.id} className={`px-2 py-1 rounded ${pb.type === "ban" ? "bg-red-500/20" : "bg-emerald-500/20"}`}>
              {pb.type === "ban" ? "🚫" : "✅"} {pb.hero_name}
            </span>
          ))}
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
            <span key={o.id} className="px-2 py-1 rounded bg-white/10 capitalize">
              {o.minute_mark}&apos; {o.type} ({o.team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name})
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
          <button onClick={logKeyMoment} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
            Log moment
          </button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {keyMoments.map((km) => (
            <span key={km.id} className="px-2 py-1 rounded bg-signal/20 capitalize">
              {km.minute_mark}&apos; {km.type.replace("_", " ")}
            </span>
          ))}
        </div>
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
