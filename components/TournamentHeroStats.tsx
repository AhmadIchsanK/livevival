"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { HeroIcon } from "@/components/HeroIcon";
import { useLanguage } from "@/lib/i18n";

// Hero draft stats for one tournament, computed by the tournament_hero_stats
// RPC ONLY from that tournament's FINISHED matches' pick/ban data. Two shapes:
//   variant="table" — the full sortable table on the tournament page.
//   variant="top5"  — a compact Top-5 picks / Top-5 bans meta reference for the
//                     match page draft.
type Stat = {
  hero_name: string;
  icon_url: string | null;
  picks: number;
  bans: number;
  wins: number;
  games_present: number;
  total_games: number;
};

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

type SortKey = "picks" | "bans" | "presence" | "winRate" | "hero";
type FilterKey = "all" | "picked" | "banned";

export function TournamentHeroStats({ tournamentId, variant }: { tournamentId: string; variant: "table" | "top5" | "top3" }) {
  const { t } = useLanguage();
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("picks");
  const [sortDesc, setSortDesc] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("tournament_hero_stats", { p_tournament_id: tournamentId });
      if (!cancelled) setStats((data as Stat[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  const totalGames = stats?.[0]?.total_games ?? 0;
  const isMini = variant === "top5" || variant === "top3";
  const topN = variant === "top3" ? 3 : 5;
  const topPicks = useMemo(() => [...(stats ?? [])].sort((a, b) => b.picks - a.picks).filter((s) => s.picks > 0).slice(0, topN), [stats, topN]);
  const topBans = useMemo(() => [...(stats ?? [])].sort((a, b) => b.bans - a.bans).filter((s) => s.bans > 0).slice(0, topN), [stats, topN]);
  // Top win rate — only heroes with enough picks to be meaningful (≥2), best
  // rate first, tie-broken by pick volume so a 1/1 fluke can't top a 8/10.
  const topWinRate = useMemo(
    () =>
      [...(stats ?? [])]
        .filter((s) => s.picks >= 2)
        .sort((a, b) => b.wins / b.picks - a.wins / a.picks || b.picks - a.picks)
        .slice(0, topN),
    [stats, topN]
  );

  if (stats && stats.length === 0) {
    if (isMini) return null; // stay quiet on the match page when there's nothing
    return <p className="text-white/30 text-sm">{t("hs.noData")}</p>;
  }
  if (!stats) {
    return <div className="h-24 rounded-lg bg-white/5 animate-pulse" />;
  }

  // ── Compact Top-N reference (match page draft) ────────────────────────
  // "top5": Top picks / Top bans. "top3": Top 3 picks / bans / win rate.
  if (isMini) {
    const Col = ({ title, rows, kind }: { title: string; rows: Stat[]; kind: "picks" | "bans" | "winRate" }) => (
      <div className="flex-1 min-w-[150px]">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50 mb-1.5">{title}</p>
        {rows.length === 0 ? (
          <p className="text-white/25 text-xs">—</p>
        ) : (
          <ol className="space-y-1">
            {rows.map((s, i) => (
              <li key={s.hero_name} className="flex items-center gap-2 text-sm">
                <span className="w-4 text-white/30 tabular-nums text-xs">{i + 1}</span>
                {s.icon_url ? <HeroIcon url={s.icon_url} name={s.hero_name} size="xs" /> : <span className="w-5 h-5 rounded bg-white/10" />}
                <span className="truncate flex-1">{s.hero_name}</span>
                <span className="text-white/40 text-xs tabular-nums">
                  {kind === "winRate"
                    ? `${Math.round((s.wins / s.picks) * 100)}% · ${s.picks}×`
                    : `${kind === "picks" ? s.picks : s.bans}× · ${pct(kind === "picks" ? s.picks : s.bans, totalGames)}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
    return (
      <div className="lv-card-flush p-4">
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-white/70 font-semibold text-sm">🎯 {t("hs.metaRef")}</p>
          <span className="text-[11px] text-white/30">{t("hs.games", { n: totalGames })}</span>
        </div>
        <div className="flex gap-6 flex-wrap">
          <Col title={variant === "top3" ? t("hs.top3Picks") : t("hs.topPicks")} rows={topPicks} kind="picks" />
          <Col title={variant === "top3" ? t("hs.top3Bans") : t("hs.topBans")} rows={topBans} kind="bans" />
          {variant === "top3" && <Col title={t("hs.top3WinRate")} rows={topWinRate} kind="winRate" />}
        </div>
      </div>
    );
  }

  // ── Full table (tournament page) ──────────────────────────────────────
  const winRateOf = (s: Stat) => (s.picks > 0 ? s.wins / s.picks : -1);
  const valueOf = (s: Stat, k: SortKey): number | string => {
    switch (k) {
      case "picks": return s.picks;
      case "bans": return s.bans;
      case "presence": return s.games_present;
      case "winRate": return winRateOf(s);
      case "hero": return s.hero_name.toLowerCase();
    }
  };
  const q = query.trim().toLowerCase();
  const filtered = stats
    .filter((s) => (filter === "picked" ? s.picks > 0 : filter === "banned" ? s.bans > 0 : true))
    .filter((s) => (q ? s.hero_name.toLowerCase().includes(q) : true));
  const sorted = [...filtered].sort((a, b) => {
    const va = valueOf(a, sortKey);
    const vb = valueOf(b, sortKey);
    let cmp: number;
    if (typeof va === "string" && typeof vb === "string") cmp = va.localeCompare(vb);
    else cmp = (va as number) - (vb as number);
    return sortDesc ? -cmp : cmp;
  });
  const shown = expanded ? sorted : sorted.slice(0, 15);
  const filterOpts: { key: FilterKey; label: string }[] = [
    { key: "all", label: t("hs.filterAll") },
    { key: "picked", label: t("hs.filterPicked") },
    { key: "banned", label: t("hs.filterBanned") },
  ];
  // Toolbar order (metrics first, hero last); table header order (hero first).
  const sortOpts: { key: SortKey; label: string }[] = [
    { key: "picks", label: t("hs.picks") },
    { key: "bans", label: t("hs.bans") },
    { key: "presence", label: t("hs.presence") },
    { key: "winRate", label: t("hs.winRate") },
    { key: "hero", label: t("hs.hero") },
  ];
  const columns: { key: SortKey; label: string }[] = [
    { key: "hero", label: t("hs.hero") },
    { key: "picks", label: t("hs.picks") },
    { key: "bans", label: t("hs.bans") },
    { key: "presence", label: t("hs.presence") },
    { key: "winRate", label: t("hs.winRate") },
  ];
  const applySort = (k: SortKey) => {
    if (k === sortKey) setSortDesc((v) => !v);
    else {
      setSortKey(k);
      setSortDesc(k !== "hero"); // names default A→Z, numbers default high→low
    }
  };
  return (
    <div className="space-y-3">
      {/* Controls: filter chips + search + sort */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-white/40">{t("hs.filter")}</span>
        <div className="flex gap-1">
          {filterOpts.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-md text-xs transition ${
                filter === f.key ? "bg-white/15 text-white" : "bg-white/5 text-white/50 hover:text-white/80"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("hs.search")}
          className="ml-auto min-w-[130px] flex-1 sm:flex-none rounded-md bg-white/5 border border-white/10 px-2.5 py-1 text-xs text-white/80 placeholder-white/30 focus:outline-none focus:border-white/25"
        />
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/40">{t("hs.sortBy")}</span>
          {sortOpts.map((o) => (
            <button
              key={o.key}
              onClick={() => applySort(o.key)}
              className={`px-2 py-1 rounded-md text-xs transition ${
                sortKey === o.key ? "bg-white/15 text-white" : "bg-white/5 text-white/50 hover:text-white/80"
              }`}
            >
              {o.label}
              {sortKey === o.key && <span className="ml-0.5 text-white/50">{sortDesc ? "↓" : "↑"}</span>}
            </button>
          ))}
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="text-white/30 text-sm">{t("hs.noMatch")}</p>
      ) : (
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/40 bg-white/5">
              {columns.map((o, i) => (
                <th
                  key={o.key}
                  onClick={() => applySort(o.key)}
                  className={`py-2.5 px-3 font-semibold cursor-pointer select-none hover:text-white/70 ${i === 0 ? "" : "text-right"}`}
                >
                  {o.label}
                  {sortKey === o.key && <span className="ml-0.5 text-white/60">{sortDesc ? "↓" : "↑"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const wr = s.picks > 0 ? s.wins / s.picks : null;
              return (
                <tr key={s.hero_name} className="border-t border-white/[0.07] hover:bg-white/[0.03]">
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2.5">
                      {s.icon_url ? <HeroIcon url={s.icon_url} name={s.hero_name} size="xs" /> : <span className="w-5 h-5 rounded bg-white/10" />}
                      <span className="font-medium">{s.hero_name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {s.picks} <span className="text-white/30 text-xs">· {pct(s.picks, s.total_games)}</span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {s.bans} <span className="text-white/30 text-xs">· {pct(s.bans, s.total_games)}</span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-white/70">{pct(s.games_present, s.total_games)}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {wr == null ? (
                      <span className="text-white/25">—</span>
                    ) : (
                      <span className={wr >= 0.55 ? "text-emerald-400" : wr <= 0.45 ? "text-red-400/80" : "text-white/80"}>
                        {Math.round(wr * 100)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      {sorted.length > 15 && (
        <button onClick={() => setExpanded((v) => !v)} className="lv-btn-ghost text-xs">
          {expanded ? t("hs.showLess") : t("hs.showAll", { n: sorted.length })}
        </button>
      )}
    </div>
  );
}
