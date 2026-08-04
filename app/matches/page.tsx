"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { BrandLockup } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { MatchCard } from "@/components/MatchCard";

type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
  tournament: { name: string; tier: string; liquipedia_slug: string | null } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type GameRow = { match_id: string; winner_team_id: string | null };

// Same fields as the home page's own MATCH_SELECT — this page reuses the
// home page's match-card component, so it needs the same data to render it.
const MATCH_SELECT = `id, status, scheduled_at, format, update_source, notification_tier,
  tournament:tournaments(name, tier, liquipedia_slug),
  team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
  team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`;

const FINISHED_FETCH_CAP = 300;

const TABS = [
  { key: "live", label: "Ongoing" },
  { key: "scheduled", label: "Upcoming" },
  { key: "finished", label: "Finished" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type SortKey = "date_asc" | "date_desc";

export default function MatchesPage() {
  return (
    <Suspense fallback={null}>
      <MatchesPageInner />
    </Suspense>
  );
}

function MatchesPageInner() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>("live");
  const [byStatus, setByStatus] = useState<Record<TabKey, MatchRow[]>>({ live: [], scheduled: [], finished: [] });
  const [scores, setScores] = useState<Record<string, { a: number; b: number }>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [sortKey, setSortKey] = useState<SortKey>("date_asc");

  useEffect(() => {
    async function load() {
      const [{ data: live }, { data: scheduled }, { data: finished }] = await Promise.all([
        supabase.from("matches").select(MATCH_SELECT).eq("status", "live").order("scheduled_at", { ascending: true }),
        supabase.from("matches").select(MATCH_SELECT).eq("status", "scheduled").order("scheduled_at", { ascending: true }),
        supabase.from("matches").select(MATCH_SELECT).eq("status", "finished").order("scheduled_at", { ascending: false }).limit(FINISHED_FETCH_CAP),
      ]);

      const liveList = (live as unknown as MatchRow[]) ?? [];
      const scheduledList = (scheduled as unknown as MatchRow[]) ?? [];
      const finishedList = (finished as unknown as MatchRow[]) ?? [];
      setByStatus({ live: liveList, scheduled: scheduledList, finished: finishedList });

      const scoredIds = [...liveList, ...finishedList].map((m) => m.id);
      if (scoredIds.length > 0) {
        const { data: games } = await supabase.from("games").select("match_id, winner_team_id").in("match_id", scoredIds);
        const teamAById = new Map([...liveList, ...finishedList].map((m) => [m.id, m.team_a?.id]));
        const teamBById = new Map([...liveList, ...finishedList].map((m) => [m.id, m.team_b?.id]));
        const byMatch: Record<string, { a: number; b: number }> = {};
        for (const g of (games as GameRow[] | null) ?? []) {
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

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = byStatus[tab].filter(
      (m) =>
        !q ||
        (m.team_a?.name ?? "").toLowerCase().includes(q) ||
        (m.team_b?.name ?? "").toLowerCase().includes(q) ||
        (m.tournament?.name ?? "").toLowerCase().includes(q)
    );
    return [...filtered].sort((a, b) => {
      const at = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
      const bt = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
      return sortKey === "date_asc" ? at - bt : bt - at;
    });
  }, [byStatus, tab, search, sortKey]);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-3xl mx-auto space-y-8">
      <header className="flex items-center justify-between">
        <BrandLockup />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <NavMenu />
        </div>
      </header>

      <div>
        <h1 className="lv-heading mb-4">Matches</h1>
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search team or tournament..."
            className="flex-1 min-w-[200px] bg-white/5 border border-white/10 rounded px-3 py-1.5 text-sm outline-none focus:border-signal"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="date_asc">Date: earliest first</option>
            <option value="date_desc">Date: latest first</option>
          </select>
        </div>
        <div className="flex gap-2 border-b border-white/10">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                tab === t.key ? "border-signal text-signal" : "border-transparent text-white/50 hover:text-white"
              }`}
            >
              {t.label} <span className="text-white/30 tabular-nums">({byStatus[t.key].length})</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-white/40 text-sm">Loading matches...</p>
      ) : (
        <div className="space-y-2">
          {list.map((m) => (
            <MatchCard
              key={m.id}
              href={`/match/${m.id}`}
              status={m.status}
              teamA={m.team_a}
              teamB={m.team_b}
              score={scores[m.id]}
              scheduledAt={m.scheduled_at}
              format={m.format}
              tier={m.tournament?.tier}
              tournamentName={m.tournament?.name}
              tournamentSlug={m.tournament?.liquipedia_slug}
              updateSource={m.update_source}
              notificationTier={m.notification_tier}
            />
          ))}
          {list.length === 0 && <p className="text-white/30 text-sm text-center py-8">No matches here.</p>}
        </div>
      )}
    </main>
  );
}
