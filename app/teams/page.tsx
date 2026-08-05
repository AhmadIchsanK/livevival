"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo } from "@/components/TeamLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavMenu } from "@/components/NavMenu";
import { ViewToggle } from "@/components/ViewToggle";
import { TeamSocialLinks } from "@/components/TeamSocialLinks";
import { useViewMode } from "@/lib/useViewMode";

type Team = {
  id: string;
  name: string;
  logo_url: string | null;
  location: string | null;
  region: string | null;
  website_url: string | null;
  twitter_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  youtube_url: string | null;
  discord_url: string | null;
};
type RosterPlayer = { id: string; ign: string; role: string | null; is_active_roster: boolean };
type SortKey = "name_asc" | "name_desc";

const TEAM_COLUMNS =
  "id, name, logo_url, location, region, website_url, twitter_url, instagram_url, facebook_url, youtube_url, discord_url";

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
  const [regionFilter, setRegionFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [view, setView] = useViewMode("lv-view-teams");

  const [preview, setPreview] = useState<Team | null>(null);
  const [roster, setRoster] = useState<RosterPlayer[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("teams").select(TEAM_COLUMNS).order("name");
      setTeams((data as Team[]) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  // Regions aren't a fixed enum in the DB (free text, filled in by admins
  // over time) — the filter's options are derived from whatever's actually
  // present so it never shows a region with zero matching teams.
  const regions = useMemo(
    () => Array.from(new Set(teams.map((t) => t.region).filter((r): r is string => Boolean(r)))).sort(),
    [teams]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = teams.filter((t) => {
      if (regionFilter && t.region !== regionFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        (t.location ?? "").toLowerCase().includes(q) ||
        (t.region ?? "").toLowerCase().includes(q)
      );
    });
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [teams, search, regionFilter, sortKey]);

  function openPreview(team: Team) {
    setPreview(team);
    setRoster(null);
    setRosterLoading(true);
    supabase
      .from("players")
      .select("id, ign, role, is_active_roster")
      .eq("team_id", team.id)
      .order("is_active_roster", { ascending: false })
      .order("ign")
      .then(({ data }) => {
        setRoster((data as RosterPlayer[]) ?? []);
        setRosterLoading(false);
      });
  }

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
          placeholder="Search teams, location, or region..."
          className="flex-1 min-w-[200px] bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60"
        />
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

      {!loading && (
        <p className="text-xs text-white/40 -mt-4">
          {teams.length} team{teams.length === 1 ? "" : "s"} total
          {visible.length !== teams.length && (
            <>
              {" "}| <span className="text-white/60">{visible.length} shown</span>
            </>
          )}
        </p>
      )}

      {loading && <p className="text-white/40 text-sm">Loading...</p>}

      {!loading && view === "grid" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {visible.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => openPreview(t)}
              className="lv-card flex flex-col items-center gap-2 px-4 py-5 text-center hover:border-signal/40 transition-colors"
            >
              <TeamLogo url={t.logo_url} size="lg" />
              <p className="font-semibold text-sm leading-tight">{t.name}</p>
              {t.location && <p className="text-xs text-white/40">{t.location}</p>}
              <TeamSocialLinks team={t} className="justify-center" />
            </button>
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
                <th className="pb-2 pt-3 px-4">Region</th>
                <th className="pb-2 pt-3 px-4">Links</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openPreview(t)}
                  className="border-t border-white/10 hover:bg-white/[0.03] transition-colors cursor-pointer"
                >
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2.5">
                      <TeamLogo url={t.logo_url} size="sm" />
                      <div>
                        <p className="font-semibold leading-tight">{t.name}</p>
                        {t.location && <p className="text-[11px] text-white/40 leading-tight">{t.location}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-white/50">{t.region ?? "—"}</td>
                  <td className="py-2 px-4">
                    <TeamSocialLinks team={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="text-white/30 text-sm px-4 py-6">No teams match.</p>}
        </div>
      )}

      {/* Mini-profile preview — a modal reusing data already on hand
          (plus an on-demand roster fetch) instead of a full team detail
          page/route, which doesn't exist yet. */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="max-w-sm w-full lv-card flex flex-col items-center gap-3 p-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <TeamLogo url={preview.logo_url} size="xl" />
            <p className="font-display font-light text-xl">{preview.name}</p>
            {(preview.location || preview.region) && (
              <p className="text-xs text-white/50">
                {[preview.location, preview.region].filter(Boolean).join(" · ")}
              </p>
            )}
            <TeamSocialLinks team={preview} className="justify-center" />

            <div className="w-full mt-2 pt-3 border-t border-white/10 text-left">
              <p className="text-xs text-white/40 uppercase tracking-wide mb-2">Roster</p>
              {rosterLoading && <p className="text-xs text-white/30">Loading roster...</p>}
              {!rosterLoading && roster && roster.length === 0 && (
                <p className="text-xs text-white/30">No players on record.</p>
              )}
              {!rosterLoading && roster && roster.length > 0 && (
                <ul className="space-y-1">
                  {roster.slice(0, 8).map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-sm">
                      <span className={p.is_active_roster ? "text-white/80" : "text-white/40 line-through"}>
                        {p.ign}
                      </span>
                      {p.role && <span className="text-[11px] text-white/40 uppercase tracking-wide">{p.role}</span>}
                    </li>
                  ))}
                  {roster.length > 8 && (
                    <li className="text-[11px] text-white/30">+{roster.length - 8} more</li>
                  )}
                </ul>
              )}
            </div>

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
