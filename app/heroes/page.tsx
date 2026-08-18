"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { HeroIcon } from "@/components/HeroIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { NavMenu } from "@/components/NavMenu";
import { useLanguage } from "@/lib/i18n";
import { ViewToggle } from "@/components/ViewToggle";
import { useViewMode } from "@/lib/useViewMode";

type Hero = {
  id: string;
  name: string;
  role: string | null;
  lane: string | null;
  region: string | null;
  icon_url: string | null;
};
type SortKey = "name_asc" | "name_desc";

export default function HeroesIndexPage() {
  return (
    <Suspense fallback={null}>
      <HeroesIndexPageInner />
    </Suspense>
  );
}

function HeroesIndexPageInner() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [roleFilter, setRoleFilter] = useState("");
  const [laneFilter, setLaneFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [view, setView] = useViewMode("lv-view-heroes");
  const [preview, setPreview] = useState<Hero | null>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("heroes").select("id, name, role, lane, region, icon_url").order("name");
      setHeroes((data as Hero[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  // None of role/lane/region are fixed enums in the DB (free text from
  // Liquipedia) — options are derived from whatever's actually present
  // instead of a hardcoded list, so a filter never offers a choice with
  // zero matches or misses one.
  const roles = useMemo(
    () => Array.from(new Set(heroes.map((h) => h.role).filter((r): r is string => Boolean(r)))).sort(),
    [heroes]
  );
  const lanes = useMemo(
    () => Array.from(new Set(heroes.map((h) => h.lane).filter((r): r is string => Boolean(r)))).sort(),
    [heroes]
  );
  const regions = useMemo(
    () => Array.from(new Set(heroes.map((h) => h.region).filter((r): r is string => Boolean(r)))).sort(),
    [heroes]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = heroes.filter((h) => {
      if (roleFilter && h.role !== roleFilter) return false;
      if (laneFilter && h.lane !== laneFilter) return false;
      if (regionFilter && h.region !== regionFilter) return false;
      if (q && !h.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [heroes, search, roleFilter, laneFilter, regionFilter, sortKey]);

  // Up to 4 other heroes sharing the previewed hero's region tag — a
  // lightweight "recommended" cross-link inside the preview.
  const recommended = useMemo(() => {
    if (!preview?.region) return [];
    return heroes.filter((h) => h.id !== preview.id && h.region === preview.region).slice(0, 4);
  }, [heroes, preview]);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-6xl mx-auto space-y-8">
      <header className="space-y-1 flex items-start justify-between">
        <div>
          <a href="/" className="lv-nav-link">&larr; {t("nav.matches")}</a>
          <h1 className="font-display font-light text-2xl tracking-tight">{t("nav.heroes")}</h1>
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
          placeholder={t("heroes.searchPlaceholder")}
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
          value={laneFilter}
          onChange={(e) => setLaneFilter(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All lanes</option>
          {lanes.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All regions</option>
          {regions.map((r) => (
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

      <p className="text-xs text-white/40 -mt-4">
        {heroes.length} heroes total · {visible.length} shown after filter
      </p>

      {loading && <p className="text-white/40 text-sm">{t("common.loadingShort")}</p>}

      {!loading && view === "grid" && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
          {visible.map((h) => (
            <button
              key={h.id}
              onClick={() => setPreview(h)}
              className="lv-card flex flex-col items-center gap-2 px-3 py-4 text-center"
            >
              <HeroIcon url={h.icon_url} name={h.name} size="lg" />
              <p className="font-semibold text-xs leading-tight">{h.name}</p>
              {h.role && <p className="text-[10px] text-white/40 uppercase tracking-wide">{h.role}</p>}
              {(h.lane || h.region) && (
                <p className="text-[9px] text-white/30 leading-tight">
                  {[h.lane, h.region].filter(Boolean).join(" · ")}
                </p>
              )}
            </button>
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
                <th className="pb-2 pt-3 px-4">Lane</th>
                <th className="pb-2 pt-3 px-4">Region</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((h) => (
                <tr
                  key={h.id}
                  onClick={() => setPreview(h)}
                  className="border-t border-white/10 hover:bg-white/[0.03] transition-colors cursor-pointer"
                >
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2.5">
                      <HeroIcon url={h.icon_url} name={h.name} size="xs" />
                      <span className="font-semibold">{h.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-white/50 text-xs uppercase tracking-wide">{h.role ?? "—"}</td>
                  <td className="py-2 px-4 text-white/50 text-xs uppercase tracking-wide">{h.lane ?? "—"}</td>
                  <td className="py-2 px-4 text-white/50 text-xs uppercase tracking-wide">{h.region ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="text-white/30 text-sm px-4 py-6">No heroes match.</p>}
        </div>
      )}

      {/* Compact mini-profile preview instead of navigating anywhere —
          there's no dedicated per-hero page. Shows core attributes plus
          up to 4 other heroes sharing the same region tag. */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="max-w-xs w-full lv-card flex flex-col items-center gap-3 p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <HeroIcon url={preview.icon_url} name={preview.name} size="xl" />
            <p className="font-display font-light text-xl">{preview.name}</p>
            <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-white/40 uppercase tracking-wide">
              {preview.role && <span className="px-2 py-0.5 rounded bg-white/10">{preview.role}</span>}
              {preview.lane && <span className="px-2 py-0.5 rounded bg-white/10">{preview.lane}</span>}
              {preview.region && <span className="px-2 py-0.5 rounded bg-white/10">{preview.region}</span>}
              {!preview.role && !preview.lane && !preview.region && <span>No attributes set</span>}
            </div>

            {preview.region && (
              <div className="w-full mt-2 pt-3 border-t border-white/10">
                <p className="text-[10px] text-white/30 uppercase tracking-wide mb-2">
                  Also from {preview.region}
                </p>
                {recommended.length > 0 ? (
                  <div className="flex items-center justify-center gap-3">
                    {recommended.map((h) => (
                      <button
                        key={h.id}
                        onClick={() => setPreview(h)}
                        className="flex flex-col items-center gap-1 w-14"
                        title={h.name}
                      >
                        <HeroIcon url={h.icon_url} name={h.name} size="sm" />
                        <span className="text-[9px] text-white/50 leading-tight truncate w-full">{h.name}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-white/30">No other heroes share this region yet.</p>
                )}
              </div>
            )}

            <button
              onClick={() => setPreview(null)}
              className="mt-2 px-3 py-1.5 rounded border border-white/10 text-white/50 hover:bg-white/5 text-xs"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
