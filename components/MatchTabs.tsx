"use client";

import { useState, type ReactNode } from "react";
import { useLanguage } from "@/lib/i18n";
import type { MsgKey } from "@/lib/messages";

// Reusable Ongoing / Upcoming / Finished tab strip for any page that lists a
// team's/tournament's/player's matches (mirrors the admin matches tabs). The
// caller supplies the raw match rows (bucketed here by `status`) and a
// renderCard function so each page keeps its own MatchCard props. Tab labels
// and empty states are localized. Defaults to the first non-empty tab.
type MatchLike = { id: string; status: string; scheduled_at: string | null };

const TABS: { key: "live" | "scheduled" | "finished"; labelKey: MsgKey; emptyKey: MsgKey }[] = [
  { key: "live", labelKey: "common.ongoing", emptyKey: "matches.noOngoing" },
  { key: "scheduled", labelKey: "common.upcoming", emptyKey: "matches.noUpcoming" },
  { key: "finished", labelKey: "common.finished", emptyKey: "matches.noFinished" },
];

export function MatchTabs<T extends MatchLike>({
  matches,
  renderCard,
  finishedNewestFirst = true,
}: {
  matches: T[];
  renderCard: (m: T) => ReactNode;
  finishedNewestFirst?: boolean;
}) {
  const { t } = useLanguage();
  const buckets: Record<string, T[]> = {
    live: matches.filter((m) => m.status === "live"),
    scheduled: matches.filter((m) => m.status === "scheduled"),
    finished: (() => {
      const f = matches.filter((m) => m.status === "finished");
      return finishedNewestFirst ? [...f].reverse() : f;
    })(),
  };
  const [tab, setTab] = useState<"live" | "scheduled" | "finished">(
    () => TABS.find((tb) => buckets[tb.key].length > 0)?.key ?? "live"
  );
  const active = TABS.find((tb) => tb.key === tab)!;
  const list = buckets[tab];

  return (
    <div className="space-y-3">
      <div className="flex gap-2 border-b border-white/10">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === tb.key ? "border-signal text-signal" : "border-transparent text-white/50 hover:text-white"
            }`}
          >
            {t(tb.labelKey)} <span className="text-white/30 tabular-nums">({buckets[tb.key].length})</span>
          </button>
        ))}
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {list.map((m) => renderCard(m))}
        {list.length === 0 && <p className="text-white/30 text-sm">{t(active.emptyKey)}</p>}
      </div>
    </div>
  );
}
