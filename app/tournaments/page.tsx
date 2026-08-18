"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { TeamLogo } from "@/components/TeamLogo";
import { NavMenu } from "@/components/NavMenu";
import { TierBadge } from "@/components/TierBadge";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  liquipedia_slug: string | null;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
  default_notification_tier: "normal" | "hot" | "priority" | null;
};

// date_display free text ("Feb 10-16, 2025", "Nov 27 - Dec 06, 2020") is the
// only date info available for older tournaments the importer never parsed
// start_date/end_date for — extracting just the trailing year is enough to
// tell "this is history" from "this hasn't happened yet" without a full
// date-range parser.
function trailingYear(dateDisplay: string | null): number | null {
  if (!dateDisplay) return null;
  const m = dateDisplay.match(/(\d{4})\s*$/);
  return m ? Number(m[1]) : null;
}

// Best-effort end date out of free-text date_display ("Feb 10-16, 2025",
// "Nov 27 - Dec 06, 2020", "Jul 14–18, 2026") — trailingYear alone only
// gives year granularity, which read a tournament that already finished
// as "upcoming" for the rest of its start year (confirmed against real
// data: "Jul 14-18, 2026" still showing as upcoming in August 2026).
// Takes the LAST day number in the string, paired with the last month
// name seen at or before it (a range only states the month once when
// both ends fall in the same month), so both single- and cross-month
// ranges resolve to their real end date.
function parseDateDisplayEnd(dateDisplay: string | null): Date | null {
  if (!dateDisplay) return null;
  const yearMatch = dateDisplay.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const withoutYear = dateDisplay.slice(0, yearMatch.index);
  const tokenRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?[a-z]*\.?\s*(\d{1,2})/gi;
  let lastMonth: string | null = null;
  let lastDay: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(withoutYear))) {
    if (match[1]) lastMonth = match[1];
    lastDay = Number(match[2]);
  }
  if (!lastMonth || lastDay == null) return null;
  const parsed = new Date(`${lastMonth} ${lastDay}, ${yearMatch[1]} 23:59:59`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
type MatchStatus = { tournament_id: string; status: string };
type SortKey = "date_desc" | "date_asc" | "name";

const COMPLETED_DEFAULT_COUNT = 8;

export default function TournamentsIndexPage() {
  return (
    <Suspense fallback={null}>
      <TournamentsIndexPageInner />
    </Suspense>
  );
}

function TournamentsIndexPageInner() {
  const searchParams = useSearchParams();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matchStatuses, setMatchStatuses] = useState<MatchStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [tierFilter, setTierFilter] = useState<"" | "S" | "A">("");
  const [sortKey, setSortKey] = useState<SortKey>("date_desc");
  const [showAllCompleted, setShowAllCompleted] = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: t }, { data: m }] = await Promise.all([
        supabase
          .from("tournaments")
          .select("id, name, tier, liquipedia_slug, date_display, start_date, end_date, logo_url, default_notification_tier")
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

    // Free-text date_display beats the match-status/year heuristics below
    // whenever it can be parsed — precise day-level "this already ended"
    // beats a coarse "some match somewhere is marked finished" guess.
    const displayEnd = parseDateDisplayEnd(t.date_display);
    if (displayEnd && Date.now() > displayEnd.getTime()) return "completed";

    const statuses = matchStatuses.filter((m) => m.tournament_id === t.id).map((m) => m.status);
    if (statuses.length === 0) {
      // No dates parsed AND no matches imported — confirmed against real
      // production data this defaulting to "upcoming" was showing
      // tournaments from 2020-2025 (ESL Snapdragon, ONE Esports MPL
      // Invitational, etc.) as upcoming. A real upcoming tournament always
      // has at least a date_display; use its year to tell history from
      // what hasn't happened yet.
      const year = trailingYear(t.date_display);
      if (year !== null && year < new Date().getFullYear()) return "completed";
      return "upcoming";
    }
    if (statuses.some((s) => s === "live")) return "ongoing";
    if (statuses.every((s) => s === "finished")) return "completed";
    if (statuses.some((s) => s === "finished") && statuses.some((s) => s === "scheduled")) return "ongoing";
    return "upcoming";
  }

  // Sorting purely on start_date pushed every tournament that only ever had
  // a free-text date_display (start_date/end_date null — most older rows,
  // but also some very recent ones like MLBB Women's International 2026)
  // to the very bottom under "Newest first", since a null coerced to ""
  // sorts before every real date string — confirmed against real data:
  // a tournament that ended weeks ago was invisible under the default
  // 8-item "Completed" cap because it sorted as if it were the oldest
  // tournament on record. Falls back to the same date_display end-date
  // parser categorize() already uses, so a tournament without parsed
  // start_date still sorts near where it actually happened.
  function sortableDate(t: Tournament): string {
    if (t.start_date) return t.start_date;
    const displayEnd = parseDateDisplayEnd(t.date_display);
    return displayEnd ? displayEnd.toISOString().slice(0, 10) : "";
  }

  function sortTournaments(list: Tournament[]) {
    const sorted = [...list];
    if (sortKey === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
    sorted.sort((a, b) => sortableDate(a).localeCompare(sortableDate(b)));
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
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-6xl mx-auto space-y-10">
      <header className="space-y-1 flex items-start justify-between">
        <div>
          <a href="/" className="lv-nav-link">&larr; Matches</a>
          <h1 className="font-display font-light text-2xl tracking-tight">Tournaments</h1>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
          <NavMenu />
        </div>
      </header>

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tournaments..."
          className="flex-1 min-w-[200px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value as "" | "S" | "A")}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All tiers</option>
          <option value="S">S-Tier</option>
          <option value="A">A-Tier</option>
        </select>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
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
      <div className="grid gap-2 lg:grid-cols-2">
        {tournaments.map((t) => (
          <a
            key={t.id}
            href={t.liquipedia_slug ? `/tournaments/${t.liquipedia_slug}` : "#"}
            className="lv-card flex items-center justify-between px-4 py-3 gap-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <TeamLogo url={t.logo_url} size="sm" />
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
            <span className="flex items-center gap-1.5 shrink-0">
              <TierBadge tier={t.default_notification_tier} />
              <span className="lv-badge bg-white/10 text-white/60 shrink-0">{t.tier}-Tier</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
