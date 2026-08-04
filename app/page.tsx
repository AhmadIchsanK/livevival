"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { BrandLockup } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { TeamLogo } from "@/components/TeamLogo";
import { GlobalSearch } from "@/components/GlobalSearch";
import { formatCountdown, COUNTDOWN_WINDOW_MS } from "@/lib/countdown";

type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
  series_winner_team_id: string | null;
  tournament: { name: string; tier: string; liquipedia_slug: string | null; logo_url: string | null } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type GameRow = { match_id: string; winner_team_id: string | null };

const PAGE_SIZE = 30;
const UPCOMING_DAYS_RANGE = 30;
const FINISHED_FETCH_CAP = 300; // generous, but bounded — see note below

const MATCH_SELECT = `id, status, scheduled_at, format, update_source, notification_tier, series_winner_team_id,
  tournament:tournaments(name, tier, liquipedia_slug, logo_url),
  team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
  team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`;

// A team name of 13+ characters ("Bigetron by Vitality", "Team Falcons PH")
// overflows the fixed-width name column on a phone-sized card — shrink the
// font for long names instead of letting them wrap/clip.
function teamNameSizeClass(name: string | null | undefined, base: string, long: string) {
  return (name?.length ?? 0) >= 13 ? long : base;
}

// A match can be marked "finished" with a real series_winner_team_id even
// though no game ever got a winner recorded — a walkover/withdrawal, not an
// actual 0-0. games.winner_team_id-derived scores can't distinguish "this
// hasn't started" from "this was decided without being played", so this
// checks the one signal that can: a finished match whose game-derived score
// is still 0-0 despite already having a declared series winner.
function isForfeitWin(m: MatchRow, score: { a: number; b: number } | undefined) {
  return m.status === "finished" && !!m.series_winner_team_id && (!score || (score.a === 0 && score.b === 0));
}

function ForfeitBadge() {
  return (
    <span
      className="lv-badge bg-red-600/20 text-red-400 border border-red-600/40 shrink-0"
      title="Decided by walkover — no games were played"
    >
      🟥 W.O.
    </span>
  );
}

// Hot = fully admin/OCR-controlled (KDA, items, moment log all available).
// Normal = Liquipedia auto-sync only (score, picks/bans, VOD). Shown so
// fans know which matches will have the deeper coverage. Separate from —
// and shown alongside — the notification_tier badge below: this one is
// about depth of on-site coverage, that one is about who gets Telegram/
// Slack pinged.
function HotBadge({ updateSource }: { updateSource: "liquipedia" | "local_ocr" }) {
  if (updateSource !== "local_ocr") return null;
  return (
    <span className="lv-badge bg-signal/20 text-signal border border-signal/40 shrink-0" title="Fully admin-tracked: live KDA, items, and moment log">
      🔥 HOT
    </span>
  );
}

// notification_tier badge — independent axis from update_source above (see
// the migration). Priority gets a bell (🔔) per spec. Hot only gets its own
// badge here when it *disagrees* with update_source (a Liquipedia-synced
// match manually escalated to Hot notifications without switching to OCR
// capture) — otherwise it would just repeat the 🔥 HOT badge above.
function TierBadge({ tier, updateSource }: { tier: "normal" | "hot" | "priority"; updateSource: "liquipedia" | "local_ocr" }) {
  if (tier === "priority") {
    return (
      <span className="lv-badge bg-amber-400/20 text-amber-300 border border-amber-400/40 shrink-0" title="Priority notifications: automatic match-started and match-finished alerts">
        🔔 PRIORITY
      </span>
    );
  }
  if (tier === "hot" && updateSource !== "local_ocr") {
    return (
      <span className="lv-badge bg-signal/20 text-signal border border-signal/40 shrink-0" title="Hot notification tier: full automatic Telegram/Slack alerts">
        🔥 HOT ALERTS
      </span>
    );
  }
  return null;
}

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

  // Includes finished matches too (within the FINISHED_FETCH_CAP window)
  // so navigating the calendar to a past month still shows which days had
  // matches, not just the next 30 days of upcoming ones.
  const matchDates = useMemo(() => {
    const s = new Set<string>();
    for (const m of upcoming) if (m.scheduled_at) s.add(dateKey(m.scheduled_at));
    for (const m of live) if (m.scheduled_at) s.add(dateKey(m.scheduled_at));
    for (const m of finished) if (m.scheduled_at) s.add(dateKey(m.scheduled_at));
    return s;
  }, [upcoming, live, finished]);

  function jumpToDate(day: string) {
    setSelectedDate(day);
    document.getElementById(`day-${day}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-10">
      <header className="flex items-center justify-between">
        <BrandLockup />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <NavMenu />
        </div>
      </header>

      <GlobalSearch />

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
      <div className="flex items-center gap-2 mb-3">
        <p className="lv-badge-live">Live</p>
        <HotBadge updateSource={m.update_source} />
        <TierBadge tier={m.notification_tier} updateSource={m.update_source} />
      </div>
      {/* Grid with two equal 1fr columns — keeps the score dead-center
          regardless of the two team names' relative length, instead of a
          flex row where a short name lets the score drift off-center. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex items-center justify-end gap-2 min-w-0">
          <p className={`font-semibold text-right leading-tight ${teamNameSizeClass(m.team_a?.name, "text-sm", "text-xs")}`}>{m.team_a?.name ?? "TBD"}</p>
          <TeamLogo url={m.team_a?.logo_url} size="sm" />
        </div>
        <p className="lv-score text-3xl shrink-0 px-1">{seriesScoreLabel(score) ?? "vs"}</p>
        <div className="flex items-center justify-start gap-2 min-w-0">
          <TeamLogo url={m.team_b?.logo_url} size="sm" />
          <p className={`font-semibold leading-tight ${teamNameSizeClass(m.team_b?.name, "text-sm", "text-xs")}`}>{m.team_b?.name ?? "TBD"}</p>
        </div>
      </div>
      <p className="text-xs text-white/40 mt-2 truncate text-center">
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
    <div className="lv-card-flush border border-white/10 p-3 w-full max-w-[260px]">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setMonthOffset((v) => v - 1)} className="text-xs text-paper/70 hover:text-signal px-2 py-1 rounded hover:bg-white/10 transition-colors">
          ←
        </button>
        <p className="text-xs font-semibold uppercase tracking-wide text-paper">
          {viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
        <button onClick={() => setMonthOffset((v) => v + 1)} className="text-xs text-paper/70 hover:text-signal px-2 py-1 rounded hover:bg-white/10 transition-colors">
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-paper/55 mb-1">
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
                isSelected ? "bg-win text-black" : isToday ? "border border-signal/50 text-paper" : ""
              } ${hasMatch ? "hover:bg-white/10 cursor-pointer text-paper" : "text-paper/45 cursor-default"}`}
            >
              <span>{Number(key.slice(-2))}</span>
              {hasMatch && <span className={`w-1 h-1 rounded-full ${isSelected ? "bg-black" : "bg-win"}`} />}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-paper/55 mt-2">Green = at least one match that day.</p>
    </div>
  );
}

// Only for matches starting within 24h — `now` is a single shared ticking
// clock from the parent (one setInterval for the whole slider, not one per
// card). Signal-tinted chip (not just bare text) so it actually stands out
// against the card instead of blending into it — the plain white/40 text
// tried first read as barely visible against .lv-card's own translucent
// background in both themes.
//
// Rendered in normal document flow (was absolutely positioned over the
// bottom-right corner of the card) — that overlapped the tournament/time
// line above it whenever the badge's own box (border + padding) exceeded
// the small reserved bottom padding that trick depended on. A flow element
// can't overlap its siblings regardless of content length, so this is the
// robust fix rather than re-tuning magic-number offsets again.
function MatchCountdown({ scheduledAt, now }: { scheduledAt: string; now: number }) {
  const diff = new Date(scheduledAt).getTime() - now;
  if (diff <= 0 || diff > COUNTDOWN_WINDOW_MS) return null;
  return (
    <div className="flex justify-center">
      <span className="flex items-center gap-1 text-[10px] font-mono font-semibold tabular-nums text-signal bg-signal/15 border border-signal/40 rounded px-1.5 py-0.5 tracking-wide">
        ⏳ {formatCountdown(diff)}
      </span>
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

  // Only ticks while at least one match is actually within the 24h
  // countdown window — otherwise this section would re-render every
  // second for no visible reason on days with nothing imminent.
  const hasImminentMatch = matches.some((m) => {
    if (!m.scheduled_at) return false;
    const diff = new Date(m.scheduled_at).getTime() - Date.now();
    return diff > 0 && diff <= COUNTDOWN_WINDOW_MS;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasImminentMatch) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasImminentMatch]);

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
              className={`shrink-0 w-80 snap-start space-y-2 rounded-lg ${
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
                    className="lv-card block px-3 py-3 space-y-1.5"
                  >
                    {/* Same centered team/VS layout as Recent results — two
                        equal columns either side of a fixed middle column
                        so it stays centered regardless of name length. */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <div className="flex items-center justify-end gap-1.5 min-w-0">
                        <span className={`font-semibold text-right leading-tight ${teamNameSizeClass(m.team_a?.name, "text-xs", "text-[10px]")}`}>{m.team_a?.name ?? "TBD"}</span>
                        <TeamLogo url={m.team_a?.logo_url} size="sm" />
                      </div>
                      <span className="lv-score text-sm shrink-0 bg-white/5 border border-white/10 rounded-md px-2 py-1 uppercase tracking-wide">
                        vs
                      </span>
                      <div className="flex items-center justify-start gap-1.5 min-w-0">
                        <TeamLogo url={m.team_b?.logo_url} size="sm" />
                        <span className={`font-semibold leading-tight ${teamNameSizeClass(m.team_b?.name, "text-xs", "text-[10px]")}`}>{m.team_b?.name ?? "TBD"}</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-white/40 truncate text-center">
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
                      · {new Date(m.scheduled_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                    {(m.update_source === "local_ocr" || m.notification_tier !== "normal") && (
                      <div className="flex justify-center gap-1.5">
                        <HotBadge updateSource={m.update_source} />
                        <TierBadge tier={m.notification_tier} updateSource={m.update_source} />
                      </div>
                    )}
                    {m.scheduled_at && <MatchCountdown scheduledAt={m.scheduled_at} now={now} />}
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
          const forfeit = isForfeitWin(m, score);
          const aWon = forfeit ? m.series_winner_team_id === m.team_a?.id : score && score.a > score.b;
          const bWon = forfeit ? m.series_winner_team_id === m.team_b?.id : score && score.b > score.a;
          const scoreLabel = forfeit ? `${aWon ? "W" : "L"}–${bWon ? "W" : "L"}` : seriesScoreLabel(score) ?? "—";
          return (
            <a
              key={m.id}
              href={`/match/${m.id}`}
              className="lv-card block px-4 py-3 space-y-2"
            >
              {/* Score sits directly between the two logo/name groups
                  instead of floating alone on the far right edge of the
                  card, a full width away from either team. */}
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                <div className="flex items-center justify-end gap-2 min-w-0">
                  <span
                    className={`font-semibold text-right leading-tight ${teamNameSizeClass(m.team_a?.name, "text-sm", "text-xs")} ${aWon ? "text-signal" : ""}`}
                  >
                    {m.team_a?.name ?? "TBD"}
                  </span>
                  <TeamLogo url={m.team_a?.logo_url} size="sm" highlight={!!aWon} />
                </div>
                <span className="lv-score text-xl shrink-0 bg-white/5 border border-white/10 rounded-md px-3 py-1">
                  {scoreLabel}
                </span>
                <div className="flex items-center justify-start gap-2 min-w-0">
                  <TeamLogo url={m.team_b?.logo_url} size="sm" highlight={!!bWon} />
                  <span
                    className={`font-semibold leading-tight ${teamNameSizeClass(m.team_b?.name, "text-sm", "text-xs")} ${bWon ? "text-signal" : ""}`}
                  >
                    {m.team_b?.name ?? "TBD"}
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-xs text-white/40 truncate max-w-full">
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
                <div className="flex items-center gap-1.5">
                  <HotBadge updateSource={m.update_source} />
                  <TierBadge tier={m.notification_tier} updateSource={m.update_source} />
                  {forfeit && <ForfeitBadge />}
                </div>
              </div>
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
