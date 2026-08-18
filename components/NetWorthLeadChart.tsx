"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// Team A is the site's signal red; Team B a high-contrast sky blue so the two
// sides are unmistakable (the old single-line "gold lead" chart read as if the
// left team was the only subject). Kept as plain hex so the SVG gradient stops
// can reference them.
const A_COLOR = "#e31e2a";
const B_COLOR = "#38bdf8";

export type NetWorthLeadPoint = { minute: number; diff: number }; // diff = teamA_gold − teamB_gold

// A diverging "gold lead" time-series: the area rises into Team A's colour when
// Team A is ahead and drops into Team B's colour when Team B is ahead, split at
// the zero line. A headline states who leads and by how much, and a legend
// names both teams — so a viewer reads "who's winning, by how much, over time"
// at a glance instead of inferring it from a line above/below an unlabeled axis.
export function NetWorthLeadChart({
  series,
  teamAName,
  teamBName,
  height = 170,
}: {
  series: NetWorthLeadPoint[];
  teamAName?: string | null;
  teamBName?: string | null;
  height?: number;
}) {
  const a = teamAName ?? "Team A";
  const b = teamBName ?? "Team B";
  if (!series || series.length < 2) return null;

  const latest = series[series.length - 1].diff;
  const leaderName = latest === 0 ? null : latest > 0 ? a : b;
  const leaderColor = latest > 0 ? A_COLOR : B_COLOR;
  const leadK = (Math.abs(latest) / 1000).toFixed(1);

  // Zero-crossing as a fraction from the top of the plot, for the split gradient.
  const max = Math.max(0, ...series.map((d) => d.diff));
  const min = Math.min(0, ...series.map((d) => d.diff));
  const off = max === min ? 0.5 : max / (max - min);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 text-[11px] text-white/60">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: A_COLOR }} />
            {a}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: B_COLOR }} />
            {b}
          </span>
        </div>
        <p className="text-xs font-semibold" style={{ color: leaderName ? leaderColor : "rgba(255,255,255,0.6)" }}>
          {leaderName ? `${leaderName} leads +${leadK}K gold` : "Gold even"}
        </p>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={series} margin={{ top: 6, right: 8, bottom: 2, left: 4 }}>
          <defs>
            <linearGradient id="nwlead-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset={off} stopColor={A_COLOR} stopOpacity={0.55} />
              <stop offset={off} stopColor={B_COLOR} stopOpacity={0.55} />
            </linearGradient>
            <linearGradient id="nwlead-stroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset={off} stopColor={A_COLOR} />
              <stop offset={off} stopColor={B_COLOR} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="minute"
            tickFormatter={(m: number) => `${m}m`}
            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
            axisLine={false}
            tickLine={false}
            minTickGap={22}
          />
          <YAxis
            tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${(v / 1000).toFixed(0)}K`}
            tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
            axisLine={false}
            tickLine={false}
            width={34}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.28)" />
          <Tooltip
            contentStyle={{ background: "#111116", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, fontSize: 12 }}
            labelFormatter={(m: number) => `${m} min`}
            formatter={(v: number) => [`${v >= 0 ? a : b} +${(Math.abs(v) / 1000).toFixed(1)}K`, "Gold lead"]}
          />
          <Area type="monotone" dataKey="diff" stroke="url(#nwlead-stroke)" strokeWidth={2} fill="url(#nwlead-fill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <p className="text-[10px] text-white/30 text-center">
        Gold lead over time — up = <span style={{ color: A_COLOR }}>{a}</span> ahead, down = <span style={{ color: B_COLOR }}>{b}</span> ahead
      </p>
    </div>
  );
}
