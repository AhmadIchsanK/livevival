"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
import type { MsgKey } from "@/lib/messages";

// Each destination page already has its own search/filter/sort UI
// (players, teams, heroes, tournaments, matches) — this is just the entry
// point: pick a category, type a term, land on that page with ?q= already
// filled in.
const CATEGORIES: { value: string; labelKey: MsgKey }[] = [
  { value: "matches", labelKey: "search.cat.match" },
  { value: "tournaments", labelKey: "search.cat.tournament" },
  { value: "players", labelKey: "search.cat.player" },
  { value: "teams", labelKey: "search.cat.team" },
  { value: "heroes", labelKey: "search.cat.hero" },
] as const;

export function GlobalSearch() {
  const router = useRouter();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["value"]>("matches");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    router.push(`/${category}${params}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 flex-wrap">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("search.placeholder")}
        className="flex-1 min-w-[220px] bg-white/5 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number]["value"])}
        title={t("search.filterByCategory")}
        className="bg-white/5 border border-white/10 rounded px-2 py-2 text-sm"
      >
        {CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {t(c.labelKey)}
          </option>
        ))}
      </select>
      <button type="submit" className="lv-btn-primary">
        {t("search.button")}
      </button>
    </form>
  );
}
