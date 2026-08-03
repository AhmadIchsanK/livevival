"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";

type Team = { id: string; name: string; short_name: string | null; logo_url: string | null };
type SortKey = "name_asc" | "name_desc";

export default function TeamsIndexPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");

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
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-4xl mx-auto space-y-8">
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
      </div>

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
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
    </main>
  );
}
