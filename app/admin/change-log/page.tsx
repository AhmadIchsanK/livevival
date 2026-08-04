"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type LogRow = {
  id: number;
  table_name: string;
  row_id: string | null;
  operation: "INSERT" | "UPDATE" | "DELETE";
  actor_id: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_at: string;
};

const PAGE_SIZE = 50;
const TABLES = [
  "teams", "players", "matches", "tournaments", "streams", "games", "hero_picks_bans",
  "key_moments", "player_stats", "heroes", "objectives", "net_worth_snapshots",
  "tournament_results", "capture_regions", "moment_templates", "telegram_notifications",
  "item_snapshots", "vision_detections", "game_screenshots", "admins", "contributors", "edit_requests",
];

const OP_CLASS: Record<LogRow["operation"], string> = {
  INSERT: "bg-signal/20 text-signal",
  UPDATE: "bg-white/10 text-white/60",
  DELETE: "bg-red-500/20 text-red-400",
};

export default function ChangeLogPage() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [actorLabels, setActorLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [tableFilter, setTableFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    let query = supabase
      .from("activity_log")
      .select("id, table_name, row_id, operation, actor_id, old_data, new_data, changed_at")
      .order("changed_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (tableFilter) query = query.eq("table_name", tableFilter);
    if (dateFrom) query = query.gte("changed_at", new Date(dateFrom).toISOString());
    if (dateTo) query = query.lte("changed_at", new Date(dateTo + "T23:59:59").toISOString());

    const { data } = await query;
    const logRows = (data as LogRow[]) ?? [];
    setRows(logRows);

    const actorIds = Array.from(new Set(logRows.map((r) => r.actor_id).filter(Boolean))) as string[];
    if (actorIds.length > 0) {
      const [{ data: admins }, { data: contributors }] = await Promise.all([
        supabase.from("admins").select("user_id, email").in("user_id", actorIds),
        supabase.from("contributors").select("user_id, name").in("user_id", actorIds),
      ]);
      const labels: Record<string, string> = {};
      for (const a of (admins as { user_id: string; email: string }[]) ?? []) labels[a.user_id] = `${a.email} (admin)`;
      for (const c of (contributors as { user_id: string; name: string }[]) ?? []) {
        if (!labels[c.user_id]) labels[c.user_id] = `${c.name} (contributor)`;
      }
      setActorLabels(labels);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, tableFilter, dateFrom, dateTo]);

  return (
    <div className="text-white space-y-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Change Log</h1>

      <div className="flex gap-2 flex-wrap">
        <select
          value={tableFilter}
          onChange={(e) => {
            setPage(0);
            setTableFilter(e.target.value);
          }}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
        >
          <option value="">All tables</option>
          {TABLES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => {
            setPage(0);
            setDateFrom(e.target.value);
          }}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => {
            setPage(0);
            setDateTo(e.target.value);
          }}
          className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
        />
      </div>

      {loading ? (
        <p className="text-white/40 text-sm">Loading...</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className="lv-card-flush p-3">
              <button
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                className="w-full flex items-center justify-between gap-3 text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`lv-badge shrink-0 ${OP_CLASS[r.operation]}`}>{r.operation}</span>
                  <span className="text-sm font-semibold">{r.table_name}</span>
                  <span className="text-xs text-white/40 truncate">
                    {r.actor_id ? actorLabels[r.actor_id] ?? r.actor_id : "System (scraper)"}
                  </span>
                </div>
                <span className="text-xs text-white/40 shrink-0">{new Date(r.changed_at).toLocaleString()}</span>
              </button>
              {expandedId === r.id && (
                <pre className="mt-2 text-[10px] text-white/60 bg-black/30 rounded p-2 overflow-x-auto">
                  {JSON.stringify({ before: r.old_data, after: r.new_data }, null, 2)}
                </pre>
              )}
            </div>
          ))}
          {rows.length === 0 && <p className="text-white/30 text-sm">No activity matching these filters.</p>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          className="px-3 py-1.5 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs disabled:opacity-40"
        >
          ← Newer
        </button>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={rows.length < PAGE_SIZE}
          className="px-3 py-1.5 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs disabled:opacity-40"
        >
          Older →
        </button>
      </div>
    </div>
  );
}
