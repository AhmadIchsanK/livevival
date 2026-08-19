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

export function TournamentHeroStats({ tournamentId, variant }: { tournamentId: string; variant: "table" | "top5" }) {
  const { t } = useLanguage();
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [expanded, setExpanded] = useState(false);

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
  const topPicks = useMemo(() => [...(stats ?? [])].sort((a, b) => b.picks - a.picks).filter((s) => s.picks > 0).slice(0, 5), [stats]);
  const topBans = useMemo(() => [...(stats ?? [])].sort((a, b) => b.bans - a.bans).filter((s) => s.bans > 0).slice(0, 5), [stats]);

  if (stats && stats.length === 0) {
    if (variant === "top5") return null; // stay quiet on the match page when there's nothing
    return <p className="text-white/30 text-sm">{t("hs.noData")}</p>;
  }
  if (!stats) {
    return <div className="h-24 rounded-lg bg-white/5 animate-pulse" />;
  }

  // ── Compact Top-5 reference (match page) ──────────────────────────────
  if (variant === "top5") {
    const Col = ({ title, rows, kind }: { title: string; rows: Stat[]; kind: "picks" | "bans" }) => (
      <div className="flex-1 min-w-[150px]">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50 mb-1.5">{title}</p>
        <ol className="space-y-1">
          {rows.map((s, i) => (
            <li key={s.hero_name} className="flex items-center gap-2 text-sm">
              <span className="w-4 text-white/30 tabular-nums text-xs">{i + 1}</span>
              {s.icon_url ? <HeroIcon url={s.icon_url} name={s.hero_name} size="xs" /> : <span className="w-5 h-5 rounded bg-white/10" />}
              <span className="truncate flex-1">{s.hero_name}</span>
              <span className="text-white/40 text-xs tabular-nums">{kind === "picks" ? s.picks : s.bans}× · {pct(kind === "picks" ? s.picks : s.bans, totalGames)}</span>
            </li>
          ))}
        </ol>
      </div>
    );
    return (
      <div className="lv-card-flush p-4">
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-white/70 font-semibold text-sm">🎯 {t("hs.metaRef")}</p>
          <span className="text-[11px] text-white/30">{t("hs.games", { n: totalGames })}</span>
        </div>
        <div className="flex gap-6 flex-wrap">
          <Col title={t("hs.topPicks")} rows={topPicks} kind="picks" />
          <Col title={t("hs.topBans")} rows={topBans} kind="bans" />
        </div>
      </div>
    );
  }

  // ── Full table (tournament page) ──────────────────────────────────────
  const shown = expanded ? stats : stats.slice(0, 15);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/40 bg-white/5">
              <th className="py-2.5 px-3 font-semibold">{t("hs.hero")}</th>
              <th className="py-2.5 px-3 font-semibold text-right">{t("hs.picks")}</th>
              <th className="py-2.5 px-3 font-semibold text-right">{t("hs.bans")}</th>
              <th className="py-2.5 px-3 font-semibold text-right">{t("hs.presence")}</th>
              <th className="py-2.5 px-3 font-semibold text-right">{t("hs.winRate")}</th>
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
      {stats.length > 15 && (
        <button onClick={() => setExpanded((v) => !v)} className="lv-btn-ghost text-xs">
          {expanded ? t("hs.showLess") : t("hs.showAll", { n: stats.length })}
        </button>
      )}
    </div>
  );
}
