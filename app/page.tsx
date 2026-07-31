"use client";

import { useEffect, useRef, useState } from "react";
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

const PAGE_SIZE = 30;
const UPCOMING_DAYS_RANGE = 30;

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
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Livevival</h1>
          <p className="text-sm text-white/50">RevivalTV Esports Live Score — MLBB S-Tier & A-Tier</p>
        </div>
        <a href="/tournaments" className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5">
          Tournaments
        </a>
      </header>

      {loading && <p className="text-white/40 text-sm">Loading matches...</p>}

      {!loading && live.length > 0 && (
        <>
          <Section title="🔴 Live now" matches={live} />
          <hr className="border-white/10" />
        </>
      )}

      {!loading && (
        <>
          <UpcomingDaySlider matches={upcoming} />
          <hr className="border-white/10" />
        </>
      )}

      {!loading && (
        <Section title="Recent results" matches={finished} empty="No finished matches yet." />
      )}
    </main>
  );
}

function dateKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function UpcomingDaySlider({ matches }: { matches: MatchRow[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Group into calendar-day buckets for the next 30 days. Days with no
  // matches are skipped entirely, so the slider only shows days worth
  // scrolling to rather than 30 mostly-empty cards.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + UPCOMING_DAYS_RANGE);

  const byDay = new Map<string, MatchRow[]>();
  for (const m of matches) {
    if (!m.scheduled_at) continue;
    const d = new Date(m.scheduled_at);
    if (d < today || d > rangeEnd) continue;
    const key = dateKey(m.scheduled_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(m);
  }
  const days = Array.from(byDay.keys()).sort();

  function scrollBy(amount: number) {
    scrollerRef.current?.scrollBy({ left: amount, behavior: "smooth" });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Upcoming — next {UPCOMING_DAYS_RANGE} days</h2>
        {days.length > 0 && (
          <div className="flex gap-1">
            <button onClick={() => scrollBy(-320)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">←</button>
            <button onClick={() => scrollBy(320)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">→</button>
          </div>
        )}
      </div>

      {days.length === 0 && <p className="text-white/30 text-sm">No upcoming matches scheduled in the next {UPCOMING_DAYS_RANGE} days.</p>}

      {days.length > 0 && (
        <div ref={scrollerRef} className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory">
          {days.map((day) => (
            <div key={day} className="shrink-0 w-72 snap-start space-y-2">
              <p className="text-xs font-semibold text-white/60 sticky top-0">
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
                    className="block border border-white/10 rounded-lg px-3 py-2 hover:border-white/30 transition"
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

function Section({ title, matches, empty }: { title: string; matches: MatchRow[]; empty?: string }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visible = matches.slice(0, visibleCount);
  const hasMore = matches.length > visibleCount;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">{title}</h2>
      {matches.length === 0 && empty && <p className="text-white/30 text-sm">{empty}</p>}
      <div className="space-y-2">
        {visible.map((m) => (
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
      {hasMore && (
        <button
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5"
        >
          See more ({matches.length - visibleCount} more)
        </button>
      )}
    </section>
  );
}
