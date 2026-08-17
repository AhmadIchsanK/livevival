"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type SyncJob = {
  workflow: "tournaments" | "details";
  title: string;
  description: string;
  runUrl: string;
};

type SyncLogRow = {
  id: string;
  created_at: string;
  triggered_by: string | null;
  workflow: string;
  tournament_slugs: string | null;
  status: string;
  detail: string | null;
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

function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function DataSyncPage() {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // Optional per-tournament targeting, shared by both jobs. Comma-separated
  // liquipedia_slug values (e.g. "MPL/Indonesia/Season_18,MPL/Malaysia/Season_18")
  // re-sync just those, bypassing the past-year window + table order — the fast
  // way to repair one tournament that didn't auto-update. Blank = full pass.
  const [slugs, setSlugs] = useState("");
  const [log, setLog] = useState<SyncLogRow[]>([]);

  const loadLog = useCallback(async () => {
    const { data } = await supabase
      .from("sync_log")
      .select("id, created_at, triggered_by, workflow, tournament_slugs, status, detail")
      .order("created_at", { ascending: false })
      .limit(15);
    setLog((data as SyncLogRow[]) ?? []);
  }, []);

  useEffect(() => {
    loadLog();
  }, [loadLog]);

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

    const targeted = slugs.trim();
    try {
      const res = await fetch("/api/admin/refresh-liquipedia", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workflow: job.workflow, tournamentSlugs: targeted || undefined }),
      });
      const data = await res.json();
      setStatus((prev) => ({
        ...prev,
        [job.workflow]: res.ok
          ? targeted
            ? `Triggered for: ${targeted} — usually lands in a few minutes.`
            : "Triggered (full pass) — usually takes 15-60 min depending on rate limiting."
          : data.error ?? "Failed to trigger.",
      }));
      // Reflect the new audit-log row (dispatched or error) right away.
      loadLog();
    } catch (err) {
      setStatus((prev) => ({ ...prev, [job.workflow]: (err as Error).message }));
    } finally {
      setLoading((prev) => ({ ...prev, [job.workflow]: false }));
    }
  }

  return (
    <div className="text-white space-y-6 max-w-4xl">
      <div>
        <h1 className="lv-heading text-lg">Data sync</h1>
        <p className="text-xs text-white/40 mt-1">
          These normally run on a schedule (every 6h) via GitHub Actions. Use this to pull the latest from Liquipedia
          right now instead of waiting for the next cycle — useful right after a new tournament/match goes up, or to
          confirm a fix actually landed.
        </p>
      </div>

      <div className="lv-card-flush p-4 space-y-2">
        <label className="block text-xs font-semibold text-white/70">
          Target specific tournament(s) — optional
        </label>
        <input
          value={slugs}
          onChange={(e) => setSlugs(e.target.value)}
          placeholder="MPL/Indonesia/Season_18,MPL/Malaysia/Season_18"
          className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal/60 font-mono"
        />
        <p className="text-xs text-white/40">
          Comma-separated Liquipedia slug(s). When set, only those tournaments are re-synced — bypasses the past-year
          window and table order, so a single tournament that didn&apos;t auto-update lands in minutes instead of
          waiting for a full pass. Leave blank for a normal full pass.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
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
                {loading[job.workflow] ? "Triggering..." : slugs.trim() ? "Sync targeted" : "Sync now"}
              </button>
              <a href={job.runUrl} target="_blank" className="text-xs text-white/40 hover:text-signal">
                View runs ↗
              </a>
            </div>
            {status[job.workflow] && <p className="text-xs text-white/60">{status[job.workflow]}</p>}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="lv-heading text-sm">Recent manual syncs</h2>
          <button onClick={loadLog} className="text-xs text-white/40 hover:text-signal">
            Refresh
          </button>
        </div>
        {log.length === 0 ? (
          <p className="text-xs text-white/30">No manual syncs recorded yet.</p>
        ) : (
          <div className="lv-card-flush divide-y divide-white/5">
            {log.map((row) => (
              <div key={row.id} className="flex items-start gap-3 px-3 py-2 text-xs">
                <span
                  className={`mt-0.5 shrink-0 lv-badge ${
                    row.status === "dispatched" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
                  }`}
                >
                  {row.status}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-white/80">
                    <span className="font-semibold">{row.workflow}</span>
                    {row.tournament_slugs ? (
                      <span className="text-white/50 font-mono"> · {row.tournament_slugs}</span>
                    ) : (
                      <span className="text-white/40"> · full pass</span>
                    )}
                  </p>
                  <p className="text-white/40">
                    {row.triggered_by ?? "unknown"} · {timeAgo(row.created_at)}
                    {row.detail ? <span className="text-red-300/70"> · {row.detail}</span> : null}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
