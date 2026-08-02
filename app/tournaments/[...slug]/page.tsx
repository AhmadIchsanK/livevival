"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
  fmvp_player: { ign: string; team: { name: string; logo_url: string | null } | null } | null;
};
type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type Standing = {
  id: string;
  placement: string;
  placement_sort: number | null;
  team_name_raw: string;
  prize_usd: number | null;
  team: { name: string; logo_url: string | null } | null;
};
type PlayerPerformance = {
  playerId: string;
  ign: string;
  teamName: string | null;
  games: number;
  kills: number;
  deaths: number;
  assists: number;
};

function MatchRowCard({ m, score }: { m: MatchRow; score?: { a: number; b: number } }) {
  const scoreLabel = score ? `${score.a}–${score.b}` : null;
  return (
    <a
      href={`/match/${m.id}`}
      className="lv-card flex items-center justify-between px-4 py-3"
    >
      <div>
        <p className="font-semibold text-sm flex items-center gap-1.5">
          {m.team_a?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proxiedImageUrl(m.team_a.logo_url)} alt="" className="w-4 h-4 rounded object-contain shrink-0" />
          ) : null}
          {m.team_a?.name ?? "TBD"} <span className="text-white/30">vs</span> {m.team_b?.name ?? "TBD"}
          {m.team_b?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proxiedImageUrl(m.team_b.logo_url)} alt="" className="w-4 h-4 rounded object-contain shrink-0" />
          ) : null}
        </p>
        <p className="text-xs text-white/40">
          {m.format}{m.scheduled_at ? ` · ${new Date(m.scheduled_at).toLocaleString()}` : ""}
        </p>
      </div>
      {scoreLabel ? (
        <span className="lv-score text-lg shrink-0 bg-white/5 border border-white/10 rounded-md px-3 py-1.5">{scoreLabel}</span>
      ) : (
        <span
          className={
            m.status === "live" ? "lv-badge-live" : m.status === "finished" ? "lv-badge-finished" : "lv-badge-scheduled"
          }
        >
          {m.status}
        </span>
      )}
    </a>
  );
}

export default function TournamentPage() {
  const params = useParams();
  const slugParts = params.slug as string[] | undefined;
  const slug = (slugParts ?? []).join("/");

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [scores, setScores] = useState<Record<string, { a: number; b: number }>>({});
  const [standings, setStandings] = useState<Standing[]>([]);
  const [performances, setPerformances] = useState<PlayerPerformance[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(20);

  useEffect(() => {
    if (!slug) return;
    async function load() {
      const { data: t } = await supabase
        .from("tournaments")
        .select("id, name, tier, date_display, start_date, end_date, logo_url, fmvp_player:players(ign, team:teams(name, logo_url))")
        .eq("liquipedia_slug", slug)
        .maybeSingle();

      if (!t) {
        setNotFound(true);
        return;
      }
      setTournament(t as unknown as Tournament);

      const [{ data: m }, { data: s }] = await Promise.all([
        supabase
          .from("matches")
          .select(
            `id, status, scheduled_at, format,
             team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
             team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`
          )
          .eq("tournament_id", t.id)
          .order("scheduled_at", { ascending: true }),
        supabase
          .from("tournament_results")
          .select("id, placement, placement_sort, team_name_raw, prize_usd, team:teams(name, logo_url)")
          .eq("tournament_id", t.id)
          .order("placement_sort", { ascending: true }),
      ]);
      const matchList = (m as unknown as MatchRow[]) ?? [];
      setMatches(matchList);
      setStandings((s as unknown as Standing[]) ?? []);

      // "Player achievements" — built from player_stats already recorded
      // against this tournament's matches (no separate MVP data source
      // exists), aggregated across every game and ranked by a simple
      // KDA-style score. Same shape of data the per-match MVP line uses.
      // player_stats has no tournament_id — filter via this tournament's
      // own match IDs instead.
      const matchIds = matchList.map((mm) => mm.id);
      const { data: statRows } = matchIds.length
        ? await supabase
            .from("player_stats")
            .select("player_id, kills, deaths, assists, player:players(ign, team:teams(name))")
            .in("match_id", matchIds)
        : { data: [] };
      const byPlayer = new Map<string, PlayerPerformance>();
      for (const row of (statRows ?? []) as unknown as { player_id: string; kills: number; deaths: number; assists: number; player: { ign: string; team: { name: string } | null } | null }[]) {
        if (!row.player_id || !row.player) continue;
        const existing = byPlayer.get(row.player_id) ?? {
          playerId: row.player_id,
          ign: row.player.ign,
          teamName: row.player.team?.name ?? null,
          games: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
        };
        existing.games += 1;
        existing.kills += row.kills ?? 0;
        existing.deaths += row.deaths ?? 0;
        existing.assists += row.assists ?? 0;
        byPlayer.set(row.player_id, existing);
      }
      setPerformances(
        [...byPlayer.values()]
          .sort((a, b) => b.kills + b.assists - b.deaths - (a.kills + a.assists - a.deaths))
          .slice(0, 5)
      );

      const scoredIds = matchList.filter((mm) => mm.status !== "scheduled").map((mm) => mm.id);
      if (scoredIds.length > 0) {
        const { data: games } = await supabase
          .from("games")
          .select("match_id, winner_team_id")
          .in("match_id", scoredIds);
        const teamAById = new Map(matchList.map((mm) => [mm.id, mm.team_a?.id]));
        const teamBById = new Map(matchList.map((mm) => [mm.id, mm.team_b?.id]));
        const byMatch: Record<string, { a: number; b: number }> = {};
        for (const g of games ?? []) {
          if (!g.winner_team_id) continue;
          const entry = byMatch[g.match_id] ?? { a: 0, b: 0 };
          if (g.winner_team_id === teamAById.get(g.match_id)) entry.a += 1;
          else if (g.winner_team_id === teamBById.get(g.match_id)) entry.b += 1;
          byMatch[g.match_id] = entry;
        }
        setScores(byMatch);
      }
    }
    load();
  }, [slug]);

  if (notFound) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center text-white/50 text-sm gap-2">
        <p>No tournament found for &quot;{slug}&quot;.</p>
        <a href="/tournaments" className="lv-nav-link">Back to all tournaments</a>
      </main>
    );
  }

  if (!tournament) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  const upcomingAndLive = matches.filter((m) => m.status !== "finished");
  const history = [...matches.filter((m) => m.status === "finished")].reverse();
  const visibleHistory = history.slice(0, historyVisibleCount);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-3xl mx-auto space-y-8">
      <a href="/tournaments" className="lv-nav-link">&larr; All tournaments</a>
      <header className="flex items-start gap-4">
        {tournament.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={proxiedImageUrl(tournament.logo_url)} alt="" className="w-14 h-14 rounded object-contain shrink-0" />
        )}
        <div>
          <span className="lv-badge bg-white/10 text-white/60">{tournament.tier}-Tier</span>
          <h1 className="font-display font-light text-3xl tracking-tight mt-2">{tournament.name}</h1>
          {(tournament.start_date || tournament.end_date) ? (
            <p className="text-sm text-white/40 mt-1">
              {tournament.start_date ?? "?"} → {tournament.end_date ?? "?"}
            </p>
          ) : (
            tournament.date_display && <p className="text-sm text-white/40 mt-1">{tournament.date_display}</p>
          )}
        </div>
      </header>

      {(tournament.fmvp_player || standings.some((s) => s.prize_usd)) && (
        <section className="flex flex-wrap gap-4 text-sm">
          {tournament.fmvp_player && (
            <div className="lv-card-flush px-4 py-3 flex items-center gap-2">
              <span className="text-white/40 text-xs uppercase tracking-wide">FMVP</span>
              {tournament.fmvp_player.team?.logo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={proxiedImageUrl(tournament.fmvp_player.team.logo_url)} alt="" className="w-5 h-5 rounded object-contain" />
              )}
              <span className="font-semibold">{tournament.fmvp_player.ign}</span>
              {tournament.fmvp_player.team && <span className="text-white/40">({tournament.fmvp_player.team.name})</span>}
            </div>
          )}
          {standings.some((s) => s.prize_usd) && (
            <div className="lv-card-flush px-4 py-3 flex items-center gap-2">
              <span className="text-white/40 text-xs uppercase tracking-wide">Total prize pool</span>
              <span className="font-semibold tabular-nums">
                ${standings.reduce((sum, s) => sum + (s.prize_usd ?? 0), 0).toLocaleString()}
              </span>
            </div>
          )}
        </section>
      )}

      {standings.length > 0 && (
        <section className="space-y-3">
          <h2 className="lv-heading">Final standings</h2>
          <div className="lv-card-flush overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-white/40 text-left bg-white/[0.03]">
                <tr><th className="pb-2 pt-3 px-4">Place</th><th className="pb-2 pt-3">Team</th><th className="pb-2 pt-3 px-4 text-right">Prize</th></tr>
              </thead>
              <tbody>
                {standings.map((s) => (
                  <tr key={s.id} className="border-t border-white/10 hover:bg-white/[0.03] transition-colors">
                    <td className="py-2 px-4 font-semibold text-signal">{s.placement}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        {s.team?.logo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={proxiedImageUrl(s.team.logo_url)} alt="" className="w-5 h-5 rounded object-contain shrink-0" />
                        ) : (
                          <div className="w-5 h-5 shrink-0" />
                        )}
                        {s.team?.name ?? s.team_name_raw}
                      </div>
                    </td>
                    <td className="py-2 px-4 text-right text-white/60 tabular-nums">
                      {s.prize_usd ? `$${s.prize_usd.toLocaleString()}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {performances.length > 0 && (
        <section className="space-y-3">
          <h2 className="lv-heading">Player performances</h2>
          <p className="text-xs text-white/40 -mt-2">Top by combined kills + assists − deaths, across all recorded games.</p>
          <div className="lv-card-flush overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-white/40 text-left bg-white/[0.03]">
                <tr>
                  <th className="pb-2 pt-3 px-4">Player</th>
                  <th className="pb-2 pt-3">Team</th>
                  <th className="pb-2 pt-3 text-right">K/D/A</th>
                  <th className="pb-2 pt-3 px-4 text-right">Games</th>
                </tr>
              </thead>
              <tbody>
                {performances.map((p) => (
                  <tr key={p.playerId} className="border-t border-white/10">
                    <td className="py-2 px-4 font-semibold">{p.ign}</td>
                    <td className="py-2 text-white/60">{p.teamName ?? "—"}</td>
                    <td className="py-2 text-right tabular-nums">{p.kills}/{p.deaths}/{p.assists}</td>
                    <td className="py-2 px-4 text-right text-white/60 tabular-nums">{p.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="lv-heading">Upcoming &amp; live</h2>
        <div className="space-y-2">
          {upcomingAndLive.map((m) => <MatchRowCard key={m.id} m={m} score={scores[m.id]} />)}
          {upcomingAndLive.length === 0 && <p className="text-white/30 text-sm">No upcoming matches scheduled yet.</p>}
        </div>
      </section>

      <hr className="border-white/10" />

      <section className="space-y-3">
        <h2 className="lv-heading">Match history</h2>
        <div className="space-y-2">
          {visibleHistory.map((m) => <MatchRowCard key={m.id} m={m} score={scores[m.id]} />)}
          {history.length === 0 && <p className="text-white/30 text-sm">No finished matches yet.</p>}
        </div>
        {history.length > historyVisibleCount && (
          <button
            onClick={() => setHistoryVisibleCount((c) => c + 20)}
            className="lv-btn-ghost"
          >
            See more ({history.length - historyVisibleCount} more)
          </button>
        )}
      </section>
    </main>
  );
}
