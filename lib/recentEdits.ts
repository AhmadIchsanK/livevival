import { supabase } from "@/lib/supabaseClient";

export type RecentEdit = { changedAt: string; actorLabel: string };

// Last-edit lookup for admin list rows ("edited 2h ago by X") — a thin
// read over activity_log (see app/admin/change-log for the full audit
// trail this summarizes) scoped to one table and a specific set of row
// ids, so a list page never has to pull the whole log just to label its
// own rows.
export async function loadRecentEdits(table: string, rowIds: string[]): Promise<Record<string, RecentEdit>> {
  if (rowIds.length === 0) return {};

  const { data } = await supabase
    .from("activity_log")
    .select("row_id, actor_id, changed_at")
    .eq("table_name", table)
    .in("row_id", rowIds)
    .order("changed_at", { ascending: false });

  const latestByRow = new Map<string, { actor_id: string | null; changed_at: string }>();
  for (const row of (data as { row_id: string | null; actor_id: string | null; changed_at: string }[]) ?? []) {
    if (!row.row_id || latestByRow.has(row.row_id)) continue;
    latestByRow.set(row.row_id, row);
  }
  if (latestByRow.size === 0) return {};

  const actorIds = Array.from(new Set(Array.from(latestByRow.values()).map((r) => r.actor_id).filter(Boolean))) as string[];
  const labels: Record<string, string> = {};
  if (actorIds.length > 0) {
    const [{ data: admins }, { data: contributors }] = await Promise.all([
      supabase.from("admins").select("user_id, email").in("user_id", actorIds),
      supabase.from("contributors").select("user_id, name").in("user_id", actorIds),
    ]);
    for (const a of (admins as { user_id: string; email: string }[]) ?? []) labels[a.user_id] = a.email;
    for (const c of (contributors as { user_id: string; name: string }[]) ?? []) {
      if (!labels[c.user_id]) labels[c.user_id] = c.name;
    }
  }

  const result: Record<string, RecentEdit> = {};
  for (const [rowId, entry] of latestByRow) {
    result[rowId] = {
      changedAt: entry.changed_at,
      actorLabel: entry.actor_id ? labels[entry.actor_id] ?? "unknown user" : "system (scraper)",
    };
  }
  return result;
}

export function timeAgoShort(iso: string): string {
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
