"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";

type Hero = { id: string; name: string; role: string | null; icon_url: string | null };
type SortKey = "name_asc" | "name_desc";

export default function HeroesIndexPage() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");

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
      </div>

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {visible.map((h) => (
            <div key={h.id} className="lv-card flex flex-col items-center gap-2 px-3 py-4 text-center">
              <TeamLogo url={h.icon_url} size="md" />
              <p className="font-semibold text-xs leading-tight">{h.name}</p>
              {h.role && <p className="text-[10px] text-white/40 uppercase tracking-wide">{h.role}</p>}
            </div>
          ))}
          {visible.length === 0 && <p className="text-white/30 text-sm col-span-full">No heroes match.</p>}
        </div>
      )}
    </main>
  );
}
