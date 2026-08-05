"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { MatchCard } from "@/components/MatchCard";
import { FollowButton } from "@/components/FollowButton";

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
  team_id: string | null;
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
  const [totalPrizePool, setTotalPrizePool] = useState(0);
  const [scrapedMvpIgn, setScrapedMvpIgn] = useState<string | null>(null);
  const [scrapedMvpPlayer, setScrapedMvpPlayer] = useState<{ ign: string; team: { name: string; logo_url: string | null } | null } | null>(null);

  // Resolves the scraped MVP IGN (from tournament_results, see loader
  // above) to an actual player row once we have it, so the FMVP card can
  // show a team logo the same way the admin-set fmvp_player does.
  useEffect(() => {
    if (!scrapedMvpIgn) return;
    supabase
      .from("players")
      .select("ign, team:teams(name, logo_url)")
      .ilike("ign", scrapedMvpIgn)
      .maybeSingle()
      .then(({ data }) => setScrapedMvpPlayer(data as unknown as { ign: string; team: { name: string; logo_url: string | null } | null } | null));
  }, [scrapedMvpIgn]);

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
          .select("id, placement, placement_sort, team_id, team_name_raw, prize_usd, team:teams(name, logo_url)")
          .eq("tournament_id", t.id)
          .order("placement_sort", { ascending: true }),
      ]);
      const matchList = (m as unknown as MatchRow[]) ?? [];
      setMatches(matchList);
      // tournament_results mixes two different kinds of rows from the same
      // Liquipedia prize-pool table: real team placements (team_id set,
      // placement like "1"/"5-8") and individual per-day/per-stage "Star
      // Player"/MVP awards (team_id null, team_name_raw is a player's IGN,
      // placement is a label like "Wild Card Day 1 Star" or "MVP") —
      // confirmed against real production data showing both interleaved in
      // one "Final standings" table. Only the team rows belong there.
      // Liquipedia renders a shared placement (e.g. "5-6") as ONE merged
      // table cell spanning both teams' rows — our scraper only reads the
      // prize off the first <td> in that span, so the second team's row
      // lands in our DB with prize_usd null even though it earned the
      // same amount. Backfilling the null from any sibling row that
      // shares the same placement text fixes both the per-row display
      // (teams tied for a placement now show the same prize instead of
      // one of them showing "—") and the total prize pool sum (which
      // previously undercounted by exactly the missing rows).
      const rawResults = (s as unknown as Standing[]) ?? [];
      const prizeByPlacement = new Map<string, number>();
      for (const r of rawResults) {
        if (r.prize_usd != null && !prizeByPlacement.has(r.placement.trim())) {
          prizeByPlacement.set(r.placement.trim(), r.prize_usd);
        }
      }
      const allResults = rawResults.map((r) =>
        r.prize_usd == null && prizeByPlacement.has(r.placement.trim())
          ? { ...r, prize_usd: prizeByPlacement.get(r.placement.trim())! }
          : r
      );
      setStandings(allResults.filter((r) => r.team_id));
      // Total prize pool should reflect the whole tournament, including
      // individual-award prizes (e.g. an MVP cash prize) — sum from every
      // row, not just the team-only rows now shown in the standings table.
      setTotalPrizePool(allResults.reduce((sum, r) => sum + (r.prize_usd ?? 0), 0));

      // An official MVP is one of those individual-award rows, not always
      // scrapable as a distinct field — reuse it here instead of requiring
      // an admin to set fmvp_player_id by hand when Liquipedia already
      // named one.
      const mvpRow = allResults.find((r) => !r.team_id && /^MVP$/i.test(r.placement.trim()));
      if (mvpRow) setScrapedMvpIgn(mvpRow.team_name_raw);

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
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <a href="/tournaments" className="lv-nav-link">&larr; All tournaments</a>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <NavMenu />
        </div>
      </div>
      <header className="flex items-start gap-4">
        {tournament.logo_url && <TeamLogo url={tournament.logo_url} size="md" />}
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="lv-badge bg-white/10 text-white/60">{tournament.tier}-Tier</span>
            <FollowButton entityType="tournament" entityId={tournament.id} />
          </div>
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

      {(tournament.fmvp_player || scrapedMvpPlayer || scrapedMvpIgn || totalPrizePool > 0) && (
        <section className="flex flex-wrap gap-4 text-sm">
          {(() => {
            // Admin-set fmvp_player_id wins if present (an explicit
            // override); otherwise use the MVP Liquipedia itself named in
            // the prize-pool table (resolved to a player row for the team
            // logo, falling back to plain text if that IGN isn't in our
            // players table yet).
            const mvp = tournament.fmvp_player ?? scrapedMvpPlayer;
            if (mvp) {
              return (
                <div className="lv-card-flush px-4 py-3 flex items-center gap-2">
                  <span className="text-white/40 text-xs uppercase tracking-wide">FMVP</span>
                  {mvp.team?.logo_url && <TeamLogo url={mvp.team.logo_url} size="sm" />}
                  <span className="font-semibold">{mvp.ign}</span>
                  {mvp.team && <span className="text-white/40">({mvp.team.name})</span>}
                </div>
              );
            }
            if (scrapedMvpIgn) {
              return (
                <div className="lv-card-flush px-4 py-3 flex items-center gap-2">
                  <span className="text-white/40 text-xs uppercase tracking-wide">FMVP</span>
                  <span className="font-semibold">{scrapedMvpIgn}</span>
                </div>
              );
            }
            return null;
          })()}
          {totalPrizePool > 0 && (
            <div className="lv-card-flush px-4 py-3 flex items-center gap-2">
              <span className="text-white/40 text-xs uppercase tracking-wide">Total prize pool</span>
              <span className="font-semibold tabular-nums">${totalPrizePool.toLocaleString()}</span>
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
                        <TeamLogo url={s.team?.logo_url} size="sm" />
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
        <div className="grid gap-2 lg:grid-cols-2">
          {upcomingAndLive.map((m) => (
            <MatchCard
              key={m.id}
              href={`/match/${m.id}`}
              status={m.status}
              teamA={m.team_a}
              teamB={m.team_b}
              score={scores[m.id]}
              scheduledAt={m.scheduled_at}
              format={m.format}
            />
          ))}
          {upcomingAndLive.length === 0 && <p className="text-white/30 text-sm">No upcoming matches scheduled yet.</p>}
        </div>
      </section>

      <hr className="border-white/10" />

      <section className="space-y-3">
        <h2 className="lv-heading">Match history</h2>
        <div className="grid gap-2 lg:grid-cols-2">
          {visibleHistory.map((m) => (
            <MatchCard
              key={m.id}
              href={`/match/${m.id}`}
              status={m.status}
              teamA={m.team_a}
              teamB={m.team_b}
              score={scores[m.id]}
              scheduledAt={m.scheduled_at}
              format={m.format}
            />
          ))}
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
