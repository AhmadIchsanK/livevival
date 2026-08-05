"use client";

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { supabase } from "@/lib/supabaseClient";

type MatchRow = {
  id: string;
  status: "scheduled" | "live" | "finished";
  notification_tier: "normal" | "hot" | "priority";
  scheduled_at: string | null;
  youtube_url: string | null;
  tournament_id: string | null;
};
type TournamentRow = { id: string; name: string; tier: "S" | "A"; start_date: string | null; end_date: string | null };
type StreamPlatformRow = { platform: "youtube" | "facebook" | "other" };
type ActivityLogPlayerInsert = { row_id: string; changed_at: string; new_data: Record<string, unknown> | null };
type ExtractionFailureRow = { id: string; source_url: string | null; error_message: string | null; created_at: string };

const TIER_COLORS: Record<string, string> = {
  priority: "#E31E2A",
  hot: "#FF8A3D",
  normal: "#8A8A8A",
};

// Relative-time formatter for the "recent" widgets on this page only —
// the rest of the site's shared date formatting (lib/formatMatchDate)
// intentionally always renders an absolute date/time, so this stays local
// rather than changing that shared helper's output everywhere.
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="lv-card p-4">
      <div className="text-[11px] uppercase tracking-widest text-white/40">{label}</div>
      <div className="font-display text-2xl text-paper mt-1">{value}</div>
      {sub && <div className="text-xs text-white/40 mt-1">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lv-card p-4">
      <div className="text-xs uppercase tracking-widest text-white/40 mb-3">{title}</div>
      <div className="h-64">{children}</div>
    </div>
  );
}

export default function AdminHome() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [streamPlatforms, setStreamPlatforms] = useState<StreamPlatformRow[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<ActivityLogPlayerInsert[]>([]);
  const [failures, setFailures] = useState<ExtractionFailureRow[]>([]);
  const [failureCount7d, setFailureCount7d] = useState<number | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let active = true;
    async function load() {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const [matchesRes, tournamentsRes, streamsRes, playersLogRes, failuresRes, failuresCountRes] = await Promise.all([
        supabase.from("matches").select("id, status, notification_tier, scheduled_at, youtube_url, tournament_id"),
        supabase.from("tournaments").select("id, name, tier, start_date, end_date"),
        supabase.from("streams").select("platform"),
        supabase
          .from("activity_log")
          .select("row_id, changed_at, new_data")
          .eq("table_name", "players")
          .eq("operation", "INSERT")
          .order("changed_at", { ascending: false })
          .limit(8),
        supabase
          .from("extraction_failures")
          .select("id, source_url, error_message, created_at")
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("extraction_failures")
          .select("id", { count: "exact", head: true })
          .gte("created_at", sevenDaysAgo),
      ]);

      if (!active) return;
      setMatches((matchesRes.data as MatchRow[]) ?? []);
      setTournaments((tournamentsRes.data as TournamentRow[]) ?? []);
      setStreamPlatforms((streamsRes.data as StreamPlatformRow[]) ?? []);
      setRecentPlayers((playersLogRes.data as ActivityLogPlayerInsert[]) ?? []);
      setFailures((failuresRes.data as ExtractionFailureRow[]) ?? []);
      setFailureCount7d(failuresCountRes.count ?? 0);
      setLoading(false);
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const tournamentById = useMemo(() => {
    const map = new Map<string, TournamentRow>();
    for (const t of tournaments) map.set(t.id, t);
    return map;
  }, [tournaments]);

  // --- Real-time match status summary, by tier within each status ---
  const statusSummary = useMemo(() => {
    const base = { live: 0, scheduled: 0, finished: 0 };
    const tierByStatus: Record<string, Record<string, number>> = { live: {}, scheduled: {}, finished: {} };
    for (const m of matches) {
      if (m.status in base) base[m.status as keyof typeof base]++;
      const bucket = tierByStatus[m.status] ?? (tierByStatus[m.status] = {});
      bucket[m.notification_tier] = (bucket[m.notification_tier] ?? 0) + 1;
    }
    return { base, tierByStatus };
  }, [matches]);

  function tierSubline(status: "live" | "scheduled" | "finished"): string {
    const bucket = statusSummary.tierByStatus[status] ?? {};
    const parts = (["priority", "hot", "normal"] as const)
      .filter((t) => bucket[t])
      .map((t) => `${bucket[t]} ${t}`);
    return parts.length ? parts.join(" · ") : "—";
  }

  // --- Upcoming tournament deadlines: end_date in the future, soonest first ---
  const upcomingDeadlines = useMemo(() => {
    return tournaments
      .filter((t) => t.end_date && daysUntil(t.end_date) >= 0)
      .sort((a, b) => (a.end_date! < b.end_date! ? -1 : 1))
      .slice(0, 6);
  }, [tournaments]);

  // --- Stream ingestion: matches with vs without a resolved youtube_url ---
  const streamIngestion = useMemo(() => {
    const total = matches.length;
    const resolved = matches.filter((m) => m.youtube_url).length;
    const rate = total > 0 ? Math.round((resolved / total) * 100) : 0;
    const missingFinished = matches
      .filter((m) => m.status === "finished" && !m.youtube_url)
      .sort((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? ""))
      .slice(0, 5);
    return { total, resolved, rate, missingFinished };
  }, [matches]);

  // --- Chart: match volume by month, last 12 months ---
  const volumeByMonth = useMemo(() => {
    const now = new Date();
    const buckets: { key: string; label: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      buckets.push({ key, label, count: 0 });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const m of matches) {
      if (!m.scheduled_at) continue;
      const d = new Date(m.scheduled_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.count++;
    }
    return buckets;
  }, [matches]);

  // --- Chart: matches by tournament tier (S vs A) — this repo has no
  // geographic "region" field on matches/tournaments, so tier (the axis
  // that actually exists in the schema) stands in for it here rather than
  // inventing a region that isn't tracked anywhere. ---
  const volumeByTier = useMemo(() => {
    const counts: Record<string, number> = { S: 0, A: 0, Unknown: 0 };
    for (const m of matches) {
      const t = m.tournament_id ? tournamentById.get(m.tournament_id) : undefined;
      const tier = t?.tier ?? "Unknown";
      counts[tier] = (counts[tier] ?? 0) + 1;
    }
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([tier, count]) => ({ tier: tier === "S" ? "S-Tier" : tier === "A" ? "A-Tier" : "Unlinked", count }));
  }, [matches, tournamentById]);

  // --- Chart: tournament participation — top 10 tournaments by match count ---
  const topTournaments = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      if (!m.tournament_id) continue;
      counts.set(m.tournament_id, (counts.get(m.tournament_id) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ name: tournamentById.get(id)?.name ?? "Unknown", count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .reverse(); // horizontal bar reads top-to-bottom as highest-first
  }, [matches, tournamentById]);

  // --- Chart: platform engagement — streams grouped by platform ---
  const platformBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of streamPlatforms) counts[s.platform] = (counts[s.platform] ?? 0) + 1;
    return Object.entries(counts).map(([platform, count]) => ({ platform, count }));
  }, [streamPlatforms]);

  const isDark = !mounted || resolvedTheme !== "light";
  const chartColors = isDark
    ? { grid: "rgba(255,255,255,0.08)", axis: "rgba(255,255,255,0.45)", tooltipBg: "#141414", tooltipBorder: "rgba(255,255,255,0.15)" }
    : { grid: "rgba(10,10,10,0.08)", axis: "rgba(10,10,10,0.5)", tooltipBg: "#ffffff", tooltipBorder: "rgba(10,10,10,0.15)" };
  const PLATFORM_COLORS: Record<string, string> = { youtube: "#E31E2A", facebook: "#3B82F6", other: "#8A8A8A" };
  const tooltipStyle = {
    background: chartColors.tooltipBg,
    border: `1px solid ${chartColors.tooltipBorder}`,
    borderRadius: 6,
    fontSize: 12,
  };

  return (
    <div className="text-white space-y-6">
      <div>
        <h1 className="lv-heading text-lg">Admin dashboard</h1>
        <p className="text-sm text-white/50 mt-1">
          Liquipedia import runs on a schedule (see .github/workflows) and an always-on poller (Railway) keeps
          live/imminent matches close to real-time. A match can be switched to local-OCR (admin PC) control from its
          live console at any time.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-white/40">Loading dashboard…</div>
      ) : (
        <>
          {/* Real-time match status summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Live now" value={statusSummary.base.live} sub={tierSubline("live")} />
            <StatTile label="Upcoming" value={statusSummary.base.scheduled} sub={tierSubline("scheduled")} />
            <StatTile label="Finished" value={statusSummary.base.finished} sub={tierSubline("finished")} />
            <StatTile
              label="Stream link coverage"
              value={`${streamIngestion.rate}%`}
              sub={`${streamIngestion.resolved} / ${streamIngestion.total} matches`}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Upcoming tournament deadlines */}
            <div className="lv-card p-4">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-3">Upcoming tournament deadlines</div>
              {upcomingDeadlines.length === 0 ? (
                <div className="text-sm text-white/40">No tournaments with an end date coming up.</div>
              ) : (
                <ul className="space-y-2">
                  {upcomingDeadlines.map((t) => {
                    const days = daysUntil(t.end_date!);
                    return (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                        <a href={`/admin/tournaments`} className="truncate hover:text-signal transition-colors">
                          {t.name}
                        </a>
                        <span
                          className={`shrink-0 text-xs font-semibold ${days <= 2 ? "text-signal" : "text-white/40"}`}
                        >
                          {days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Recent player registrations */}
            <div className="lv-card p-4">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-3">Recent player registrations</div>
              {recentPlayers.length === 0 ? (
                <div className="text-sm text-white/40">
                  No recently-added players in the activity log yet — most existing rows predate the audit trigger.
                </div>
              ) : (
                <ul className="space-y-2">
                  {recentPlayers.map((row) => (
                    <li key={row.row_id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{(row.new_data?.ign as string) ?? "Unknown player"}</span>
                      <span className="shrink-0 text-xs text-white/40">{timeAgo(row.changed_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Error logs: extraction failures */}
            <div className="lv-card p-4">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-3">
                Extraction failures <span className="text-white/30">· {failureCount7d ?? 0} in last 7d</span>
              </div>
              {failures.length === 0 ? (
                <div className="text-sm text-white/40">No logged title/thumbnail extraction failures.</div>
              ) : (
                <ul className="space-y-2">
                  {failures.map((f) => (
                    <li key={f.id} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-white/70">{f.error_message ?? "Extraction failed"}</span>
                        <span className="shrink-0 text-xs text-white/40">{timeAgo(f.created_at)}</span>
                      </div>
                      {f.source_url && <div className="truncate text-xs text-white/30">{f.source_url}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Stream ingestion detail: finished matches still missing a link */}
          {streamIngestion.missingFinished.length > 0 && (
            <div className="lv-card p-4">
              <div className="text-xs uppercase tracking-widest text-white/40 mb-3">
                Finished matches missing a stream link
              </div>
              <ul className="space-y-1.5">
                {streamIngestion.missingFinished.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <a href="/admin/matches" className="truncate hover:text-signal transition-colors">
                      {tournamentById.get(m.tournament_id ?? "")?.name ?? "Unknown tournament"}
                    </a>
                    <span className="shrink-0 text-xs text-white/40">
                      {m.scheduled_at ? new Date(m.scheduled_at).toLocaleDateString() : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Interactive charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Match volume — last 12 months">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={volumeByMonth} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={chartColors.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: chartColors.axis, fontSize: 11 }} axisLine={{ stroke: chartColors.grid }} tickLine={false} />
                  <YAxis tick={{ fill: chartColors.axis, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: chartColors.axis }} />
                  <Line type="monotone" dataKey="count" name="Matches" stroke="#E31E2A" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Tournament participation — top 10 by match count">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topTournaments} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke={chartColors.grid} horizontal={false} />
                  <XAxis type="number" tick={{ fill: chartColors.axis, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    tick={{ fill: chartColors.axis, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                  />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: chartColors.axis }} />
                  <Bar dataKey="count" name="Matches" fill="#E31E2A" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Matches by tournament tier">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volumeByTier} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={chartColors.grid} vertical={false} />
                  <XAxis dataKey="tier" tick={{ fill: chartColors.axis, fontSize: 11 }} axisLine={{ stroke: chartColors.grid }} tickLine={false} />
                  <YAxis tick={{ fill: chartColors.axis, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: chartColors.axis }} />
                  <Bar dataKey="count" name="Matches" fill="#FF8A3D" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Platform engagement — streams by platform">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={platformBreakdown}
                    dataKey="count"
                    nameKey="platform"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {platformBreakdown.map((entry) => (
                      <Cell key={entry.platform} fill={PLATFORM_COLORS[entry.platform] ?? "#8A8A8A"} />
                    ))}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 11, color: chartColors.axis }} />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: chartColors.axis }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
