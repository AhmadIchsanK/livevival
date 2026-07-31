"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type Tournament = { id: string; name: string; tier: string; date_display: string | null };
type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};

function MatchRowCard({ m }: { m: MatchRow }) {
  return (
    <a
      href={`/match/${m.id}`}
      className="flex items-center justify-between border border-white/10 rounded-lg px-4 py-3 hover:border-white/30 transition"
    >
      <div>
        <p className="font-semibold text-sm">
          {m.team_a?.name ?? "TBD"} <span className="text-white/30">vs</span> {m.team_b?.name ?? "TBD"}
        </p>
        <p className="text-xs text-white/40">
          {m.format}{m.scheduled_at ? ` · ${new Date(m.scheduled_at).toLocaleString()}` : ""}
        </p>
      </div>
      <span
        className={`text-xs px-2 py-1 rounded uppercase tracking-wide shrink-0 ${
          m.status === "live" ? "bg-emerald-500/20 text-emerald-400" : m.status === "finished" ? "bg-white/10 text-white/50" : "bg-yellow-500/20 text-yellow-400"
        }`}
      >
        {m.status}
      </span>
    </a>
  );
}

export default function TournamentPage() {
  const params = useParams();
  const slugParts = params.slug as string[] | undefined;
  const slug = (slugParts ?? []).join("/");

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(20);

  useEffect(() => {
    if (!slug) return;
    async function load() {
      const { data: t } = await supabase
        .from("tournaments")
        .select("id, name, tier, date_display")
        .eq("liquipedia_slug", slug)
        .maybeSingle();

      if (!t) {
        setNotFound(true);
        return;
      }
      setTournament(t as Tournament);

      const { data: m } = await supabase
        .from("matches")
        .select(
          `id, status, scheduled_at, format,
           team_a:teams!matches_team_a_id_fkey(name),
           team_b:teams!matches_team_b_id_fkey(name)`
        )
        .eq("tournament_id", (t as Tournament).id)
        .order("scheduled_at", { ascending: true });
      setMatches((m as unknown as MatchRow[]) ?? []);
    }
    load();
  }, [slug]);

  if (notFound) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center text-white/50 text-sm gap-2">
        <p>No tournament found for &quot;{slug}&quot;.</p>
        <a href="/tournaments" className="text-white/70 underline">Back to all tournaments</a>
      </main>
    );
  }

  if (!tournament) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  // Upcoming/live first (soonest first), finished history after (most recent first)
  // so visitors land on what's next, and can still easily scroll into past results.
  const upcomingAndLive = matches.filter((m) => m.status !== "finished");
  const history = [...matches.filter((m) => m.status === "finished")].reverse();
  const visibleHistory = history.slice(0, historyVisibleCount);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-3xl mx-auto space-y-8">
      <a href="/tournaments" className="text-xs text-white/40 hover:text-white/70">&larr; All tournaments</a>
      <header>
        <p className="text-xs text-white/50">{tournament.tier}-Tier</p>
        <h1 className="text-2xl font-bold">{tournament.name}</h1>
        {tournament.date_display && <p className="text-sm text-white/40">{tournament.date_display}</p>}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Upcoming &amp; live</h2>
        <div className="space-y-2">
          {upcomingAndLive.map((m) => <MatchRowCard key={m.id} m={m} />)}
          {upcomingAndLive.length === 0 && <p className="text-white/30 text-sm">No upcoming matches scheduled yet.</p>}
        </div>
      </section>

      <hr className="border-white/10" />

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Match history</h2>
        <div className="space-y-2">
          {visibleHistory.map((m) => <MatchRowCard key={m.id} m={m} />)}
          {history.length === 0 && <p className="text-white/30 text-sm">No finished matches yet.</p>}
        </div>
        {history.length > historyVisibleCount && (
          <button
            onClick={() => setHistoryVisibleCount((c) => c + 20)}
            className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5"
          >
            See more ({history.length - historyVisibleCount} more)
          </button>
        )}
      </section>
    </main>
  );
}
