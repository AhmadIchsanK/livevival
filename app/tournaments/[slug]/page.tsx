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

export default function TournamentPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);

  useEffect(() => {
    async function load() {
      const { data: t } = await supabase
        .from("tournaments")
        .select("id, name, tier, date_display")
        .eq("liquipedia_slug", slug)
        .maybeSingle();
      if (!t) return;
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

  if (!tournament) return <main className="min-h-screen flex items-center justify-center text-white/50 text-sm">Loading...</main>;

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-3xl mx-auto space-y-6">
      <header>
        <p className="text-xs text-white/50">{tournament.tier}-Tier</p>
        <h1 className="text-2xl font-bold">{tournament.name}</h1>
        {tournament.date_display && <p className="text-sm text-white/40">{tournament.date_display}</p>}
      </header>

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
                {m.format}{m.scheduled_at ? ` · ${new Date(m.scheduled_at).toLocaleString()}` : ""}
              </p>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded uppercase tracking-wide ${
                m.status === "live" ? "bg-emerald-500/20 text-emerald-400" : m.status === "finished" ? "bg-white/10 text-white/50" : "bg-yellow-500/20 text-yellow-400"
              }`}
            >
              {m.status}
            </span>
          </a>
        ))}
        {matches.length === 0 && <p className="text-white/30 text-sm">No matches added for this tournament yet.</p>}
      </div>
    </main>
  );
}
