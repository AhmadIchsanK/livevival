"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { PlayerCountryFlag } from "@/components/PlayerCountryFlag";
import { PlayerLinks } from "@/components/PlayerLinks";
import { countryCodeToFlagEmoji, countryCodeToName } from "@/lib/countryFlag";
import { ViewToggle } from "@/components/ViewToggle";
import { useViewMode } from "@/lib/useViewMode";

type Player = {
  id: string;
  ign: string;
  role: string | null;
  photo_url: string | null;
  real_name: string | null;
  country_codes: string[] | null;
  links: Record<string, string> | null;
  team: { id: string; name: string; logo_url: string | null } | null;
};
type SortKey = "name_asc" | "name_desc" | "team_asc";

export default function PlayersIndexPage() {
  return (
    <Suspense fallback={null}>
      <PlayersIndexPageInner />
    </Suspense>
  );
}

function PlayersIndexPageInner() {
  const searchParams = useSearchParams();
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  // Seeded from ?q= — the home page's global search links here with a term
  // already typed, so it should show up pre-filled, not require retyping.
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [roleFilter, setRoleFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [preview, setPreview] = useState<Player | null>(null);
  const [view, setView] = useViewMode("lv-view-players");

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("players")
        .select("id, ign, role, photo_url, real_name, country_codes, links, team:teams(id, name, logo_url)")
        .order("ign");
      setPlayers((data as unknown as Player[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  // Roles aren't a fixed enum in the DB (free text from Liquipedia) —
  // derived from whatever's actually present instead of a hardcoded list.
  const roles = useMemo(
    () => Array.from(new Set(players.map((p) => p.role).filter((r): r is string => Boolean(r)))).sort(),
    [players]
  );

  // Country codes actually present in the current roster set, not a fixed
  // list — same "derive from what's real" approach as `roles` above.
  const countries = useMemo(
    () =>
      Array.from(new Set(players.flatMap((p) => p.country_codes ?? []))).sort((a, b) =>
        countryCodeToName(a).localeCompare(countryCodeToName(b))
      ),
    [players]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = players.filter((p) => {
      if (roleFilter && p.role !== roleFilter) return false;
      if (countryFilter && !(p.country_codes ?? []).includes(countryFilter)) return false;
      if (q && !p.ign.toLowerCase().includes(q) && !(p.team?.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => a.ign.localeCompare(b.ign));
    if (sortKey === "name_desc") return sorted.reverse();
    if (sortKey === "team_asc") {
      return [...filtered].sort((a, b) => (a.team?.name ?? "").localeCompare(b.team?.name ?? "") || a.ign.localeCompare(b.ign));
    }
    return sorted;
  }, [players, search, roleFilter, countryFilter, sortKey]);

  return (
    <main className="min-h-screen bg-ink text-paper px-6 py-10 max-w-6xl mx-auto space-y-8">
      <header className="space-y-1 flex items-start justify-between">
        <div>
          <a href="/" className="lv-nav-link">&larr; Matches</a>
          <h1 className="font-display font-light text-2xl tracking-tight">Players</h1>
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
          placeholder="Search players or teams..."
          className="flex-1 min-w-[200px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
        <select
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
        >
          <option value="">All nationalities</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {countryCodeToFlagEmoji(c)} {countryCodeToName(c)}
            </option>
          ))}
        </select>
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
          <option value="team_asc">Team A→Z</option>
        </select>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {!loading && (
        <p className="text-xs text-white/40">
          {visible.length} of {players.length} players shown
        </p>
      )}

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && view === "grid" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {visible.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreview(p)}
              className="lv-card flex flex-col items-center gap-2 px-3 py-4 text-center hover:border-signal/40 transition-colors"
            >
              <div className="relative">
                <TeamLogo url={p.photo_url} size="md" />
                {p.country_codes && p.country_codes.length > 0 && (
                  <span
                    className="absolute -bottom-1 -right-1 text-sm leading-none bg-ink rounded-full px-0.5"
                    title={p.country_codes.map(countryCodeToName).join(" / ")}
                  >
                    {p.country_codes.map(countryCodeToFlagEmoji).join("")}
                  </span>
                )}
              </div>
              <p className="font-semibold text-sm leading-tight">{p.ign}</p>
              {p.real_name && <p className="text-[10px] text-white/40 truncate max-w-full">{p.real_name}</p>}
              {p.role && <p className="text-[10px] text-white/40 uppercase tracking-wide">{p.role}</p>}
              {p.team && (
                <div className="flex items-center gap-1.5 mt-1">
                  <TeamLogo url={p.team.logo_url} size="sm" />
                  <span className="text-xs text-white/60 truncate">{p.team.name}</span>
                </div>
              )}
              {p.links && Object.keys(p.links).length > 0 && <PlayerLinks links={p.links} className="justify-center" />}
            </button>
          ))}
          {visible.length === 0 && <p className="text-white/30 text-sm col-span-full">No players match.</p>}
        </div>
      )}

      {!loading && view === "list" && (
        <div className="lv-card-flush overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-white/40 text-left bg-white/[0.03]">
              <tr>
                <th className="pb-2 pt-3 px-4">Nationality</th>
                <th className="pb-2 pt-3 px-4">Player</th>
                <th className="pb-2 pt-3 px-4">Role</th>
                <th className="pb-2 pt-3 px-4">Team</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setPreview(p)}
                  className="border-t border-white/10 hover:bg-white/[0.03] transition-colors cursor-pointer"
                >
                  <td className="py-2 px-4 text-white/60">
                    {p.country_codes && p.country_codes.length > 0 ? (
                      <span title={p.country_codes.map(countryCodeToName).join(" / ")}>
                        {p.country_codes.map(countryCodeToFlagEmoji).join("")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2.5">
                      <TeamLogo url={p.photo_url} size="sm" />
                      <div>
                        <p className="font-semibold leading-tight">{p.ign}</p>
                        {p.real_name && <p className="text-[11px] text-white/40 leading-tight">{p.real_name}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-white/50 text-xs uppercase tracking-wide">{p.role ?? "—"}</td>
                  <td className="py-2 px-4">
                    {p.team ? (
                      <div className="flex items-center gap-1.5">
                        <TeamLogo url={p.team.logo_url} size="sm" />
                        <span className="text-white/60 truncate">{p.team.name}</span>
                      </div>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="text-white/30 text-sm px-4 py-6">No players match.</p>}
        </div>
      )}

      {/* Inline preview instead of navigating anywhere — there's no
          dedicated player page to link to, and a photo/name/team/role/
          nationality/links summary is all this data supports today. */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="max-w-xs w-full lv-card flex flex-col items-center gap-3 p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <TeamLogo url={preview.photo_url} size="xl" />
            <p className="font-display font-light text-xl">{preview.ign}</p>
            <PlayerCountryFlag codes={preview.country_codes} />
            {preview.real_name && <p className="text-xs text-white/50">{preview.real_name}</p>}
            {preview.role && <p className="text-xs text-white/40 uppercase tracking-wide">{preview.role}</p>}
            {preview.team && (
              <div className="flex items-center gap-2 mt-1">
                <TeamLogo url={preview.team.logo_url} size="sm" />
                <span className="text-sm text-white/60">{preview.team.name}</span>
              </div>
            )}
            <PlayerLinks links={preview.links} className="justify-center" />
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
