"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  tournament: { name: string; tier: string; liquipedia_slug: string | null } | null;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};

export default function Home() {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("matches")
        .select(
          `id, status, scheduled_at, format,
           tournament:tournaments(name, tier, liquipedia_slug),
           team_a:teams!matches_team_a_id_fkey(name),
           team_b:teams!matches_team_b_id_fkey(name)`
        )
        .order("scheduled_at", { ascending: true });
      setMatches((data as unknown as MatchRow[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const live = matches.filter((m) => m.status === "live");
  const upcoming = matches.filter((m) => m.status === "scheduled");
  const finished = [...matches.filter((m) => m.status === "finished")].reverse();

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Livevival</h1>
        <p className="text-sm text-white/50">RevivalTV Esports Live Score — MLBB S-Tier & A-Tier</p>
      </header>

      {loading && <p className="text-white/40 text-sm">Loading matches...</p>}

      {!loading && live.length > 0 && (
        <Section title="🔴 Live now" matches={live} />
      )}

      {!loading && (
        <Section title="Upcoming" matches={upcoming} empty="No upcoming matches scheduled yet." />
      )}

      {!loading && (
        <Section title="Recent results" matches={finished} empty="No finished matches yet." />
      )}
    </main>
  );
}

function Section({ title, matches, empty }: { title: string; matches: MatchRow[]; empty?: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">{title}</h2>
      {matches.length === 0 && empty && <p className="text-white/30 text-sm">{empty}</p>}
      <div className="space-y-2">
        {matches.map((m) => (
          <a
            key={m.id}
            href={`/match/${m.id}`}
            className="flex items-center justify-between border border-white/10 rounded-lg px-4 py-3 hover:border-white/30 transition"
          >
            <div>
              <p className="font-semibold text-sm">
                {m.team_a?.name ?? "TBD"} <span className="text-white/30">vs</span> {m.team_b?.name ?? "TBD"}
              </p>
              <p className="text-xs text-white/40">
                {m.tournament?.liquipedia_slug ? (
                  <a
                    href={`/tournaments/${m.tournament.liquipedia_slug}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-white/70 underline"
                  >
                    {m.tournament?.name}
                  </a>
                ) : (
                  m.tournament?.name
                )}{" "}
                · {m.tournament?.tier}-Tier · {m.format}
                {m.scheduled_at ? ` · ${new Date(m.scheduled_at).toLocaleString()}` : ""}
              </p>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded uppercase tracking-wide shrink-0 ${
                m.status === "live"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : m.status === "finished"
                  ? "bg-white/10 text-white/50"
                  : "bg-yellow-500/20 text-yellow-400"
              }`}
            >
              {m.status}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
