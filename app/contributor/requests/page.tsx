"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { getCurrentContributorId } from "@/lib/editRequests";

type Request = {
  id: string;
  entity_type: string;
  action: string;
  status: "pending" | "approved" | "rejected";
  review_note: string | null;
  created_at: string;
};

const STATUS_CLASS: Record<Request["status"], string> = {
  pending: "bg-white/10 text-white/60",
  approved: "bg-signal/20 text-signal",
  rejected: "bg-red-500/20 text-red-400",
};

export default function MyRequestsPage() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const contributorId = await getCurrentContributorId();
      if (!contributorId) {
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("edit_requests")
        .select("id, entity_type, action, status, review_note, created_at")
        .eq("contributor_id", contributorId)
        .order("created_at", { ascending: false });
      setRequests((data as Request[]) ?? []);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="text-white space-y-4">
      <h1 className="text-xl font-semibold">My Requests</h1>
      {loading ? (
        <p className="text-white/40 text-sm">Loading...</p>
      ) : requests.length === 0 ? (
        <p className="text-white/30 text-sm">No requests submitted yet.</p>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
            <div key={r.id} className="lv-card-flush p-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm capitalize">
                  {r.entity_type.replace("_", " ")} · {r.action}
                </p>
                <p className="text-xs text-white/40">{new Date(r.created_at).toLocaleString()}</p>
                {r.review_note && <p className="text-xs text-white/50 mt-1">{r.review_note}</p>}
              </div>
              <span className={`lv-badge shrink-0 capitalize ${STATUS_CLASS[r.status]}`}>{r.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
