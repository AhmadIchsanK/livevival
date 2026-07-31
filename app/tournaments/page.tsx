"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  liquipedia_slug: string | null;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
};
type MatchStatus = { tournament_id: string; status: string };

export default function TournamentsIndexPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matchStatuses, setMatchStatuses] = useState<MatchStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ data: t }, { data: m }] = await Promise.all([
        supabase
          .from("tournaments")
          .select("id, name, tier, liquipedia_slug, date_display, start_date, end_date")
          .order("name"),
        supabase.from("matches").select("tournament_id, status"),
      ]);
      setTournaments((t as Tournament[]) ?? []);
      setMatchStatuses((m as MatchStatus[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  // Primary source of truth: the tournament's own start/end dates, now that
  // the importer parses them from Liquipedia's date range text. Falls back
  // to match-status heuristics only for older rows imported before that
  // parsing existed (where start_date/end_date are still null).
  function categorize(t: Tournament): "ongoing" | "completed" | "upcoming" {
    if (t.start_date && t.end_date) {
      const today = new Date().toISOString().slice(0, 10);
      if (today < t.start_date) return "upcoming";
      if (today > t.end_date) return "completed";
      return "ongoing";
    }

    const statuses = matchStatuses.filter((m) => m.tournament_id === t.id).map((m) => m.status);
    if (statuses.length === 0) return "upcoming";
    if (statuses.some((s) => s === "live")) return "ongoing";
    if (statuses.every((s) => s === "finished")) return "completed";
    if (statuses.some((s) => s === "finished") && statuses.some((s) => s === "scheduled")) return "ongoing";
    return "upcoming";
  }

  const ongoing = tournaments.filter((t) => categorize(t) === "ongoing");
  const upcoming = tournaments.filter((t) => categorize(t) === "upcoming");
  const completed = tournaments.filter((t) => categorize(t) === "completed");

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-10">
      <header className="space-y-1">
        <a href="/" className="text-xs text-white/40 hover:text-white/70">&larr; Matches</a>
        <h1 className="text-2xl font-bold">Tournaments</h1>
      </header>

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && (
        <>
          <TournamentSection title="🔴 Ongoing" tournaments={ongoing} />
          <TournamentSection title="Upcoming" tournaments={upcoming} empty="No upcoming tournaments." />
          <TournamentSection title="Completed" tournaments={completed} empty="No completed tournaments yet." />
        </>
      )}
    </main>
  );
}

function TournamentSection({ title, tournaments, empty }: { title: string; tournaments: Tournament[]; empty?: string }) {
  if (tournaments.length === 0 && !empty) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">{title}</h2>
      {tournaments.length === 0 && empty && <p className="text-white/30 text-sm">{empty}</p>}
      <div className="space-y-2">
        {tournaments.map((t) => (
          <a
            key={t.id}
            href={t.liquipedia_slug ? `/tournaments/${t.liquipedia_slug}` : "#"}
            className="flex items-center justify-between border border-white/10 rounded-lg px-4 py-3 hover:border-white/30 transition"
          >
            <div>
              <p className="font-semibold text-sm">{t.name}</p>
              {t.date_display && <p className="text-xs text-white/40">{t.date_display}</p>}
            </div>
            <span className="text-xs px-2 py-1 rounded bg-white/10 uppercase shrink-0">{t.tier}-Tier</span>
          </a>
        ))}
      </div>
    </section>
  );
}
