"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { BrandLockup } from "@/components/Brand";

type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  tournament: { name: string; tier: string; liquipedia_slug: string | null } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type GameRow = { match_id: string; winner_team_id: string | null };

const PAGE_SIZE = 30;
const UPCOMING_DAYS_RANGE = 30;
const FINISHED_FETCH_CAP = 300; // generous, but bounded — see note below

const MATCH_SELECT = `id, status, scheduled_at, format,
  tournament:tournaments(name, tier, liquipedia_slug),
  team_a:teams!matches_team_a_id_fkey(id, name),
  team_b:teams!matches_team_b_id_fkey(id, name)`;

function dateKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

export default function Home() {
  const [live, setLive] = useState<MatchRow[]>([]);
  const [upcoming, setUpcoming] = useState<MatchRow[]>([]);
  const [finished, setFinished] = useState<MatchRow[]>([]);
  const [scores, setScores] = useState<Record<string, { a: number; b: number }>>({});
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const now = new Date();
      const monthAhead = new Date(now.getTime() + UPCOMING_DAYS_RANGE * 24 * 60 * 60 * 1000);

      // Three targeted queries instead of one unbounded fetch-everything —
      // Supabase caps unbounded queries at 1000 rows by default, and with
      // matches ordered ascending, any table with 1000+ total rows would
      // silently cut off future matches, which sort last.
      const [{ data: liveData }, { data: upcomingData }, { data: finishedData }] = await Promise.all([
        supabase.from("matches").select(MATCH_SELECT).eq("status", "live").order("scheduled_at", { ascending: true }),
        supabase
          .from("matches")
          .select(MATCH_SELECT)
          .eq("status", "scheduled")
          .gte("scheduled_at", now.toISOString())
          .lte("scheduled_at", monthAhead.toISOString())
          .order("scheduled_at", { ascending: true }),
        supabase
          .from("matches")
          .select(MATCH_SELECT)
          .eq("status", "finished")
          .order("scheduled_at", { ascending: false })
          .limit(FINISHED_FETCH_CAP),
      ]);

      const liveList = (liveData as unknown as MatchRow[]) ?? [];
      const upcomingList = (upcomingData as unknown as MatchRow[]) ?? [];
      const finishedList = (finishedData as unknown as MatchRow[]) ?? [];
      setLive(liveList);
      setUpcoming(upcomingList);
      setFinished(finishedList);

      // Series score (games won per side) for live + finished matches —
      // this is the headline number, so fetch every game in one batched
      // query rather than one round-trip per match.
      const scoredMatchIds = [...liveList, ...finishedList].map((m) => m.id);
      if (scoredMatchIds.length > 0) {
        const { data: games } = await supabase
          .from("games")
          .select("match_id, winner_team_id")
          .in("match_id", scoredMatchIds);

        const byMatch: Record<string, { a: number; b: number }> = {};
        const teamAById = new Map([...liveList, ...finishedList].map((m) => [m.id, m.team_a?.id]));
        const teamBById = new Map([...liveList, ...finishedList].map((m) => [m.id, m.team_b?.id]));
        for (const g of (games as GameRow[]) ?? []) {
          if (!g.winner_team_id) continue;
          const entry = byMatch[g.match_id] ?? { a: 0, b: 0 };
          if (g.winner_team_id === teamAById.get(g.match_id)) entry.a += 1;
          else if (g.winner_team_id === teamBById.get(g.match_id)) entry.b += 1;
          byMatch[g.match_id] = entry;
        }
        setScores(byMatch);
      }

      setLoading(false);
    }
    load();
  }, []);

  const matchDates = useMemo(() => {
    const s = new Set<string>();
    for (const m of upcoming) if (m.scheduled_at) s.add(dateKey(m.scheduled_at));
    for (const m of live) if (m.scheduled_at) s.add(dateKey(m.scheduled_at));
    return s;
  }, [upcoming, live]);

  function jumpToDate(day: string) {
    setSelectedDate(day);
    document.getElementById(`day-${day}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-10">
      <header className="flex items-center justify-between">
        <BrandLockup />
        <a href="/tournaments" className="lv-btn-ghost">
          Tournaments
        </a>
      </header>

      {loading && <p className="text-white/40 text-sm">Loading matches...</p>}

      {/* ── Live scores: the main focus, always first ── */}
      {!loading && (
        <section className="space-y-3">
          <h2 className="lv-heading flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-signal-light animate-lv-pulse-glow" />
            Live now
          </h2>
          {live.length === 0 && (
            <p className="text-white/30 text-sm">No matches live right now — check upcoming below.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {live.map((m) => (
              <LiveScoreCard key={m.id} m={m} score={scores[m.id]} />
            ))}
          </div>
        </section>
      )}

      <hr className="border-white/10" />

      {!loading && (
        <>
          <div className="grid gap-6 md:grid-cols-[auto,1fr] items-start">
            <MonthCalendar matchDates={matchDates} selectedDate={selectedDate} onSelect={jumpToDate} />
            <UpcomingDaySlider matches={upcoming} selectedDate={selectedDate} />
          </div>
          <hr className="border-white/10" />
        </>
      )}

      {!loading && (
        <ResultsSection matches={finished} scores={scores} />
      )}
    </main>
  );
}

function seriesScoreLabel(score: { a: number; b: number } | undefined) {
  if (!score) return null;
  return `${score.a}–${score.b}`;
}

function LiveScoreCard({ m, score }: { m: MatchRow; score: { a: number; b: number } | undefined }) {
  return (
    <a
      href={`/match/${m.id}`}
      className="lv-card lv-clip-corner block border-signal/30 bg-signal/[0.04] hover:border-signal/60 px-5 py-4"
    >
      <p className="lv-badge-live mb-3">Live</p>
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-base truncate">{m.team_a?.name ?? "TBD"}</p>
        <p className="lv-score text-3xl shrink-0">{seriesScoreLabel(score) ?? "vs"}</p>
        <p className="font-semibold text-base truncate text-right">{m.team_b?.name ?? "TBD"}</p>
      </div>
      <p className="text-xs text-white/40 mt-2 truncate">
        {m.tournament?.name} · {m.tournament?.tier}-Tier · {m.format}
      </p>
    </a>
  );
}

function MonthCalendar({
  matchDates,
  selectedDate,
  onSelect,
}: {
  matchDates: Set<string>;
  selectedDate: string | null;
  onSelect: (day: string) => void;
}) {
  const [monthOffset, setMonthOffset] = useState(0);
  const base = new Date();
  const viewMonth = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(base.toISOString());

  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  return (
    <div className="lv-card-flush p-3 w-full max-w-[260px]">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setMonthOffset((v) => v - 1)} className="text-xs text-white/40 hover:text-signal px-2 transition-colors">
          ←
        </button>
        <p className="text-xs font-semibold uppercase tracking-wide">
          {viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
        <button onClick={() => setMonthOffset((v) => v + 1)} className="text-xs text-white/40 hover:text-signal px-2 transition-colors">
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-white/30 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((key, i) => {
          if (!key) return <div key={i} />;
          const hasMatch = matchDates.has(key);
          const isToday = key === todayKey;
          const isSelected = key === selectedDate;
          return (
            <button
              key={i}
              onClick={() => hasMatch && onSelect(key)}
              disabled={!hasMatch}
              className={`aspect-square rounded text-[11px] flex flex-col items-center justify-center gap-0.5 transition ${
                isSelected ? "bg-signal text-white" : isToday ? "border border-signal/50" : ""
              } ${hasMatch ? "hover:bg-white/10 cursor-pointer" : "text-white/20 cursor-default"}`}
            >
              <span>{Number(key.slice(-2))}</span>
              {hasMatch && <span className={`w-1 h-1 rounded-full ${isSelected ? "bg-white" : "bg-signal"}`} />}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-white/30 mt-2">Dot = at least one match that day.</p>
    </div>
  );
}

function UpcomingDaySlider({ matches, selectedDate }: { matches: MatchRow[]; selectedDate: string | null }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const byDay = new Map<string, MatchRow[]>();
  for (const m of matches) {
    if (!m.scheduled_at) continue;
    const key = dateKey(m.scheduled_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(m);
  }
  const days = Array.from(byDay.keys()).sort();

  function scrollBy(amount: number) {
    scrollerRef.current?.scrollBy({ left: amount, behavior: "smooth" });
  }

  return (
    <section className="space-y-3 min-w-0">
      <div className="flex items-center justify-between">
        <h2 className="lv-heading">Upcoming — next {UPCOMING_DAYS_RANGE} days</h2>
        {days.length > 0 && (
          <div className="flex gap-1">
            <button onClick={() => scrollBy(-320)} className="lv-btn-ghost !px-2 !py-1">←</button>
            <button onClick={() => scrollBy(320)} className="lv-btn-ghost !px-2 !py-1">→</button>
          </div>
        )}
      </div>

      {days.length === 0 && <p className="text-white/30 text-sm">No upcoming matches scheduled in the next {UPCOMING_DAYS_RANGE} days.</p>}

      {days.length > 0 && (
        <div ref={scrollerRef} className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory">
          {days.map((day) => (
            <div
              key={day}
              id={`day-${day}`}
              className={`shrink-0 w-72 snap-start space-y-2 rounded-lg ${
                day === selectedDate ? "ring-2 ring-signal/60 p-2 -m-2" : ""
              }`}
            >
              <p className="text-xs font-semibold text-white/60 uppercase tracking-wide sticky top-0">
                {new Date(day + "T00:00:00").toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </p>
              <div className="space-y-2">
                {byDay.get(day)!.map((m) => (
                  <a
                    key={m.id}
                    href={`/match/${m.id}`}
                    className="lv-card block px-3 py-2"
                  >
                    <p className="font-semibold text-xs">
                      {m.team_a?.name ?? "TBD"} <span className="text-white/30">vs</span> {m.team_b?.name ?? "TBD"}
                    </p>
                    <p className="text-[11px] text-white/40 truncate">
                      {m.tournament?.name} · {new Date(m.scheduled_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ResultsSection({ matches, scores }: { matches: MatchRow[]; scores: Record<string, { a: number; b: number }> }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visible = matches.slice(0, visibleCount);
  const hasMore = matches.length > visibleCount;

  return (
    <section className="space-y-3">
      <h2 className="lv-heading">Recent results</h2>
      {matches.length === 0 && <p className="text-white/30 text-sm">No finished matches yet.</p>}
      <div className="space-y-2">
        {visible.map((m) => {
          const score = scores[m.id];
          return (
            <a
              key={m.id}
              href={`/match/${m.id}`}
              className="lv-card flex items-center justify-between px-4 py-3"
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
              <span className="lv-score text-xl shrink-0 bg-white/5 border border-white/10 rounded-md px-3 py-1.5">
                {seriesScoreLabel(score) ?? "—"}
              </span>
            </a>
          );
        })}
      </div>
      {hasMore && (
        <button
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="lv-btn-ghost"
        >
          See more ({matches.length - visibleCount} more)
        </button>
      )}
    </section>
  );
}
