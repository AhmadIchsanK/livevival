"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Application = {
  id: string;
  name: string;
  email: string;
  social_platform: string;
  social_handle: string;
  applied_at: string;
};

type FieldDiff = Record<string, { before: unknown; after: unknown }>;
type MatchLiveEdit = { table: string; action: "insert" | "update" | "delete"; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

type EditRequest = {
  id: string;
  contributor_id: string;
  entity_type: "tournament" | "team" | "player" | "hero" | "match" | "stream" | "match_live_edit";
  entity_id: string | null;
  action: "create" | "update";
  proposed_changes: FieldDiff | { edits: MatchLiveEdit[] };
  created_at: string;
  contributor: { name: string } | null;
};

// entity_type -> the actual table a flat-diff edit request applies to.
// match_live_edit is handled separately (multi-table replay, see applyMatchLiveEdit).
const ENTITY_TABLE: Record<string, string> = {
  tournament: "tournaments",
  team: "teams",
  player: "players",
  hero: "heroes",
  match: "matches",
  stream: "streams",
};

export default function ContributorRequestsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adminId, setAdminId] = useState<string | null>(null);

  async function load() {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (userId) {
      const { data: adminRow } = await supabase.from("admins").select("id").eq("user_id", userId).maybeSingle();
      setAdminId((adminRow as { id: string } | null)?.id ?? null);
    }

    const [{ data: apps }, { data: reqs }] = await Promise.all([
      supabase
        .from("contributors")
        .select("id, name, email, social_platform, social_handle, applied_at")
        .eq("status", "pending")
        .order("applied_at"),
      supabase
        .from("edit_requests")
        .select("id, contributor_id, entity_type, entity_id, action, proposed_changes, created_at, contributor:contributors(name)")
        .eq("status", "pending")
        .order("created_at"),
    ]);
    setApplications((apps as Application[]) ?? []);
    setEditRequests(((reqs as unknown as EditRequest[]) ?? []).map((r) => ({ ...r, contributor: Array.isArray(r.contributor) ? r.contributor[0] : r.contributor })));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function decideApplication(id: string, status: "approved" | "rejected") {
    const note = status === "rejected" ? prompt("Optional rejection note:") ?? undefined : undefined;
    const application = applications.find((a) => a.id === id);
    const { error } = await supabase
      .from("contributors")
      .update({ status, decided_at: new Date().toISOString(), decided_by: adminId, decision_note: note ?? null })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }

    if (application) {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (token) {
        const res = await fetch("/api/admin/notify-contributor-decision", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ email: application.email, name: application.name, status, note }),
        });
        const notifyBody = await res.json().catch(() => ({}));
        if (!notifyBody.sent) setNotice(notifyBody.error ?? "Decision saved — email not sent.");
      }
    }

    load();
  }

  // Applies a flat {field: {before, after}} diff as a normal update/insert
  // on the request's target table.
  async function applyFlatDiff(req: EditRequest) {
    const table = ENTITY_TABLE[req.entity_type];
    const diff = req.proposed_changes as FieldDiff;
    const payload: Record<string, unknown> = {};
    for (const [field, { after }] of Object.entries(diff)) payload[field] = after;

    if (req.action === "create") {
      const { error } = await supabase.from(table).insert(payload);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from(table).update(payload).eq("id", req.entity_id);
      if (error) throw new Error(error.message);
    }
  }

  // Replays every buffered {table, action, before, after} entry from a
  // finished-match live-console edit request. Not a real DB transaction
  // (each is a separate supabase-js call) — reports exactly which entries
  // succeeded/failed rather than assuming all-or-nothing, per the plan.
  async function applyMatchLiveEdit(req: EditRequest): Promise<string | null> {
    const { edits } = req.proposed_changes as { edits: MatchLiveEdit[] };
    const failures: string[] = [];
    for (const e of edits) {
      try {
        if (e.action === "insert") {
          const { error } = await supabase.from(e.table).insert(e.after as Record<string, unknown>);
          if (error) throw error;
        } else if (e.action === "update") {
          const { error } = await supabase
            .from(e.table)
            .update(e.after as Record<string, unknown>)
            .eq("id", (e.before as { id: string }).id);
          if (error) throw error;
        } else if (e.action === "delete") {
          const { error } = await supabase.from(e.table).delete().eq("id", (e.before as { id: string }).id);
          if (error) throw error;
        }
      } catch (err) {
        failures.push(`${e.table}/${e.action}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    return failures.length > 0 ? `Partial failure — ${failures.join("; ")}` : null;
  }

  async function decideEditRequest(req: EditRequest, status: "approved" | "rejected") {
    let reviewNote: string | null = null;

    if (status === "approved") {
      try {
        if (req.entity_type === "match_live_edit") {
          reviewNote = await applyMatchLiveEdit(req);
        } else {
          await applyFlatDiff(req);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to apply change.");
        return;
      }
    } else {
      reviewNote = prompt("Optional rejection note:") ?? null;
    }

    const { error } = await supabase
      .from("edit_requests")
      .update({ status, review_note: reviewNote, reviewed_by: adminId, reviewed_at: new Date().toISOString() })
      .eq("id", req.id);
    if (error) {
      setError(error.message);
      return;
    }
    load();
  }

  function renderDiff(req: EditRequest) {
    if (req.entity_type === "match_live_edit") {
      const { edits } = req.proposed_changes as { edits: MatchLiveEdit[] };
      return (
        <ul className="text-xs text-white/60 space-y-1">
          {edits.map((e, i) => (
            <li key={i}>
              <span className="text-white/40">{e.table}</span> · {e.action}
            </li>
          ))}
        </ul>
      );
    }
    const diff = req.proposed_changes as FieldDiff;
    return (
      <table className="text-xs w-full">
        <tbody>
          {Object.entries(diff).map(([field, { before, after }]) => (
            <tr key={field} className="border-b border-white/5">
              <td className="py-1 pr-2 text-white/40">{field}</td>
              <td className="py-1 pr-2 text-red-400/70 line-through">{String(before ?? "—")}</td>
              <td className="py-1 text-signal">{String(after ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="text-white space-y-10">
      <h1 className="text-xl font-semibold">Contributor Requests</h1>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-white/50">{notice}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Applications</h2>
        {loading ? (
          <p className="text-white/40 text-sm">Loading...</p>
        ) : applications.length === 0 ? (
          <p className="text-white/30 text-sm">No pending applications.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {applications.map((a) => (
              <div key={a.id} className="lv-card-flush p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-sm">{a.name}</p>
                  <p className="text-xs text-white/50">
                    {a.email} · {a.social_platform} {a.social_handle}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => decideApplication(a.id, "approved")} className="lv-btn-primary !text-xs !py-1.5">
                    Approve
                  </button>
                  <button
                    onClick={() => decideApplication(a.id, "rejected")}
                    className="px-3 py-1.5 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">Edit Requests</h2>
        {loading ? (
          <p className="text-white/40 text-sm">Loading...</p>
        ) : editRequests.length === 0 ? (
          <p className="text-white/30 text-sm">No pending edit requests.</p>
        ) : (
          <div className="space-y-3">
            {editRequests.map((r) => (
              <div key={r.id} className="lv-card-flush p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm">
                    <span className="font-semibold capitalize">{r.entity_type.replace("_", " ")}</span>{" "}
                    <span className="text-white/40">{r.action}</span> · by {r.contributor?.name ?? "unknown"}
                  </p>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => decideEditRequest(r, "approved")} className="lv-btn-primary !text-xs !py-1.5">
                      Approve
                    </button>
                    <button
                      onClick={() => decideEditRequest(r, "rejected")}
                      className="px-3 py-1.5 rounded border border-white/10 text-white/60 hover:bg-white/5 text-xs"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                {renderDiff(r)}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
