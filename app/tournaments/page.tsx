"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  liquipedia_slug: string | null;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
};
type MatchStatus = { tournament_id: string; status: string };
type SortKey = "date_desc" | "date_asc" | "name";

const COMPLETED_DEFAULT_COUNT = 8;

export default function TournamentsIndexPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matchStatuses, setMatchStatuses] = useState<MatchStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<"" | "S" | "A">("");
  const [sortKey, setSortKey] = useState<SortKey>("date_desc");
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: t }, { data: m }] = await Promise.all([
        supabase
          .from("tournaments")
          .select("id, name, tier, liquipedia_slug, date_display, start_date, end_date, logo_url")
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

  function sortTournaments(list: Tournament[]) {
    const sorted = [...list];
    if (sortKey === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
    sorted.sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
    return sortKey === "date_desc" ? sorted.reverse() : sorted;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tournaments.filter((t) => {
      if (tierFilter && t.tier !== tierFilter) return false;
      if (q && !t.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tournaments, search, tierFilter]);

  const ongoing = sortTournaments(filtered.filter((t) => categorize(t) === "ongoing"));
  // Upcoming always shows every Tier S/A tournament that matches the
  // current filter — no cap, since fans planning ahead want the full
  // schedule, not a trimmed preview.
  const upcoming = sortTournaments(filtered.filter((t) => categorize(t) === "upcoming"));
  // Completed defaults to the most recent handful — nobody wants to
  // scroll a growing multi-year archive on every visit — but a search or
  // tier filter means the fan is looking for something specific, so show
  // every match instead of hiding it behind "Show all".
  const completedAll = sortTournaments(filtered.filter((t) => categorize(t) === "completed"));
  const isFiltering = search.trim().length > 0 || tierFilter !== "";
  const completed = showAllCompleted || isFiltering ? completedAll : completedAll.slice(0, COMPLETED_DEFAULT_COUNT);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-10">
      <header className="space-y-1">
        <a href="/" className="lv-nav-link">&larr; Matches</a>
        <h1 className="font-display font-light text-2xl tracking-tight">Tournaments</h1>
      </header>

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tournaments..."
          className="flex-1 min-w-[200px] bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value as "" | "S" | "A")}
          className="bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All tiers</option>
          <option value="S">S-Tier</option>
          <option value="A">A-Tier</option>
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="name">Name A→Z</option>
        </select>
      </div>

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && (
        <>
          <TournamentSection title="Ongoing" live tournaments={ongoing} />
          <TournamentSection title="Upcoming" tournaments={upcoming} empty="No upcoming tournaments." />
          <TournamentSection title="Completed" tournaments={completed} empty="No completed tournaments yet." />
          {!isFiltering && !showAllCompleted && completedAll.length > COMPLETED_DEFAULT_COUNT && (
            <button
              onClick={() => setShowAllCompleted(true)}
              className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5"
            >
              Show all {completedAll.length} completed tournaments
            </button>
          )}
        </>
      )}
    </main>
  );
}

function TournamentSection({
  title,
  tournaments,
  empty,
  live,
}: {
  title: string;
  tournaments: Tournament[];
  empty?: string;
  live?: boolean;
}) {
  if (tournaments.length === 0 && !empty) return null;
  return (
    <section className="space-y-3">
      <h2 className="lv-heading flex items-center gap-2">
        {live && <span className="w-2 h-2 rounded-full bg-signal-light animate-lv-pulse-glow" />}
        {title}
      </h2>
      {tournaments.length === 0 && empty && <p className="text-white/30 text-sm">{empty}</p>}
      <div className="space-y-2">
        {tournaments.map((t) => (
          <a
            key={t.id}
            href={t.liquipedia_slug ? `/tournaments/${t.liquipedia_slug}` : "#"}
            className="lv-card flex items-center justify-between px-4 py-3 gap-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              {t.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={proxiedImageUrl(t.logo_url)} alt="" className="w-8 h-8 rounded object-contain shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-white/5 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{t.name}</p>
                {t.start_date || t.end_date ? (
                  <p className="text-xs text-white/40">
                    {t.start_date ?? "?"} → {t.end_date ?? "?"}
                  </p>
                ) : (
                  t.date_display && <p className="text-xs text-white/40">{t.date_display}</p>
                )}
              </div>
            </div>
            <span className="lv-badge bg-white/10 text-white/60 shrink-0">{t.tier}-Tier</span>
          </a>
        ))}
      </div>
    </section>
  );
}
