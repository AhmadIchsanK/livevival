"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { ViewToggle } from "@/components/ViewToggle";
import { useViewMode } from "@/lib/useViewMode";

type Team = { id: string; name: string; short_name: string | null; logo_url: string | null };
type SortKey = "name_asc" | "name_desc";

export default function TeamsIndexPage() {
  return (
    <Suspense fallback={null}>
      <TeamsIndexPageInner />
    </Suspense>
  );
}

function TeamsIndexPageInner() {
  const searchParams = useSearchParams();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [view, setView] = useViewMode("lv-view-teams");

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("teams").select("id, name, short_name, logo_url").order("name");
      setTeams((data as Team[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = teams.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.short_name ?? "").toLowerCase().includes(q));
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [teams, search, sortKey]);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-6xl mx-auto space-y-8">
      <header className="space-y-1 flex items-start justify-between">
        <div>
          <a href="/" className="lv-nav-link">&larr; Matches</a>
          <h1 className="font-display font-light text-2xl tracking-tight">Teams</h1>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <NavMenu />
        </div>
      </header>

      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search teams..."
          className="flex-1 min-w-[200px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="name_asc">Name A→Z</option>
          <option value="name_desc">Name Z→A</option>
        </select>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && view === "grid" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {visible.map((t) => (
            <div key={t.id} className="lv-card flex flex-col items-center gap-2 px-4 py-5 text-center">
              <TeamLogo url={t.logo_url} size="lg" />
              <p className="font-semibold text-sm leading-tight">{t.name}</p>
              {t.short_name && t.short_name !== t.name && <p className="text-xs text-white/40">{t.short_name}</p>}
            </div>
          ))}
          {visible.length === 0 && <p className="text-white/30 text-sm col-span-full">No teams match.</p>}
        </div>
      )}

      {!loading && view === "list" && (
        <div className="lv-card-flush overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-left bg-white/[0.03]">
              <tr>
                <th className="pb-2 pt-3 px-4">Team</th>
                <th className="pb-2 pt-3 px-4">Short name</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className="border-t border-white/10 hover:bg-white/[0.03] transition-colors">
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2.5">
                      <TeamLogo url={t.logo_url} size="sm" />
                      <span className="font-semibold">{t.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-white/50">
                    {t.short_name && t.short_name !== t.name ? t.short_name : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="text-white/30 text-sm px-4 py-6">No teams match.</p>}
        </div>
      )}
    </main>
  );
}
