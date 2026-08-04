"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { HeroIcon } from "@/components/HeroIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { ViewToggle } from "@/components/ViewToggle";
import { useViewMode } from "@/lib/useViewMode";

type Hero = { id: string; name: string; role: string | null; icon_url: string | null };
type SortKey = "name_asc" | "name_desc";

export default function HeroesIndexPage() {
  return (
    <Suspense fallback={null}>
      <HeroesIndexPageInner />
    </Suspense>
  );
}

function HeroesIndexPageInner() {
  const searchParams = useSearchParams();
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [roleFilter, setRoleFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [view, setView] = useViewMode("lv-view-heroes");

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("heroes").select("id, name, role, icon_url").order("name");
      setHeroes((data as Hero[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  // Roles aren't a fixed enum in the DB (free text from Liquipedia) —
  // derived from whatever's actually present instead of a hardcoded list,
  // so the filter never offers an option with zero matches or misses one.
  const roles = useMemo(
    () => Array.from(new Set(heroes.map((h) => h.role).filter((r): r is string => Boolean(r)))).sort(),
    [heroes]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = heroes.filter((h) => {
      if (roleFilter && h.role !== roleFilter) return false;
      if (q && !h.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [heroes, search, roleFilter, sortKey]);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-8">
      <header className="space-y-1 flex items-start justify-between">
        <div>
          <a href="/" className="lv-nav-link">&larr; Matches</a>
          <h1 className="font-display font-light text-2xl tracking-tight">Heroes</h1>
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
          placeholder="Search heroes..."
          className="flex-1 min-w-[200px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
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
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {visible.map((h) => (
            <div key={h.id} className="lv-card flex flex-col items-center gap-2 px-3 py-4 text-center">
              <HeroIcon url={h.icon_url} name={h.name} size="lg" />
              <p className="font-semibold text-xs leading-tight">{h.name}</p>
              {h.role && <p className="text-[10px] text-white/40 uppercase tracking-wide">{h.role}</p>}
            </div>
          ))}
          {visible.length === 0 && <p className="text-white/30 text-sm col-span-full">No heroes match.</p>}
        </div>
      )}

      {!loading && view === "list" && (
        <div className="lv-card-flush overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-left bg-white/[0.03]">
              <tr>
                <th className="pb-2 pt-3 px-4">Hero</th>
                <th className="pb-2 pt-3 px-4">Role</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((h) => (
                <tr key={h.id} className="border-t border-white/10 hover:bg-white/[0.03] transition-colors">
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2.5">
                      <HeroIcon url={h.icon_url} name={h.name} size="xs" />
                      <span className="font-semibold">{h.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-white/50 text-xs uppercase tracking-wide">{h.role ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="text-white/30 text-sm px-4 py-6">No heroes match.</p>}
        </div>
      )}
    </main>
  );
}
