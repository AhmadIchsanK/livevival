"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type SyncJob = {
  workflow: "tournaments" | "details";
  title: string;
  description: string;
  runUrl: string;
};

// Mirrors .github/workflows/liquipedia-import*.yml — kept as two separate
// dispatches (not one combined button) for the same reason those are two
// separate workflows: import-matches depends on tournaments existing, and
// the details refresh needs its own rate-limit window, so firing both at
// once would just have one queue behind the other via GitHub's
// concurrency groups rather than actually run any faster.
const SYNC_JOBS: SyncJob[] = [
  {
    workflow: "tournaments",
    title: "Tournaments, heroes & match schedules",
    description: "Discovers new S/A-Tier tournaments, hero data, and upcoming match schedules from Liquipedia.",
    runUrl: "https://github.com/AhmadIchsanK/livevival/actions/workflows/liquipedia-import.yml",
  },
  {
    workflow: "details",
    title: "Finished-match scores, picks/bans & VODs",
    description: "Refreshes team rosters and repopulates results, hero picks/bans, and per-game VODs for finished matches.",
    runUrl: "https://github.com/AhmadIchsanK/livevival/actions/workflows/liquipedia-import-details.yml",
  },
];

export default function DataSyncPage() {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  async function trigger(job: SyncJob) {
    setLoading((prev) => ({ ...prev, [job.workflow]: true }));
    setStatus((prev) => ({ ...prev, [job.workflow]: "" }));

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setStatus((prev) => ({ ...prev, [job.workflow]: "Not signed in." }));
      setLoading((prev) => ({ ...prev, [job.workflow]: false }));
      return;
    }

    try {
      const res = await fetch("/api/admin/refresh-liquipedia", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workflow: job.workflow }),
      });
      const data = await res.json();
      setStatus((prev) => ({
        ...prev,
        [job.workflow]: res.ok ? "Triggered — usually takes 15-60 min depending on rate limiting." : data.error ?? "Failed to trigger.",
      }));
    } catch (err) {
      setStatus((prev) => ({ ...prev, [job.workflow]: (err as Error).message }));
    } finally {
      setLoading((prev) => ({ ...prev, [job.workflow]: false }));
    }
  }

  return (
    <div className="text-white space-y-6 max-w-2xl">
      <div>
        <h1 className="lv-heading text-lg">Data sync</h1>
        <p className="text-xs text-white/40 mt-1">
          These normally run on a schedule (every 6h) via GitHub Actions. Use this to pull the latest from Liquipedia
          right now instead of waiting for the next cycle — useful right after a new tournament/match goes up, or to
          confirm a fix actually landed.
        </p>
      </div>

      <div className="space-y-4">
        {SYNC_JOBS.map((job) => (
          <div key={job.workflow} className="lv-card-flush p-4 space-y-2">
            <p className="font-semibold text-sm">{job.title}</p>
            <p className="text-xs text-white/50">{job.description}</p>
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={() => trigger(job)}
                disabled={loading[job.workflow]}
                className="lv-btn-primary !text-xs !py-1.5 disabled:opacity-40"
              >
                {loading[job.workflow] ? "Triggering..." : "Sync now"}
              </button>
              <a href={job.runUrl} target="_blank" className="text-xs text-white/40 hover:text-signal">
                View runs ↗
              </a>
            </div>
            {status[job.workflow] && <p className="text-xs text-white/60">{status[job.workflow]}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
