"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Each destination page already has its own search/filter/sort UI
// (players, teams, heroes, tournaments, matches) — this is just the entry
// point: pick a category, type a term, land on that page with ?q= already
// filled in.
const CATEGORIES = [
  { value: "matches", label: "Match" },
  { value: "tournaments", label: "Tournament" },
  { value: "players", label: "Player" },
  { value: "teams", label: "Team" },
  { value: "heroes", label: "Hero" },
] as const;

export function GlobalSearch() {
  const router = useRouter();
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
        placeholder="Search tournaments, players, teams, heroes, matches..."
        className="flex-1 min-w-[220px] bg-white/5 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number]["value"])}
        title="Filter by category"
        className="bg-white/5 border border-white/10 rounded px-2 py-2 text-sm"
      >
        {CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      <button type="submit" className="lv-btn-primary">
        Search
      </button>
    </form>
  );
}
