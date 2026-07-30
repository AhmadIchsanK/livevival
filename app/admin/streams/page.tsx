"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };
type Stream = {
  id: string;
  url: string;
  platform: string;
  status: string;
  overlay_template: string;
  current_match_id: string | null;
  tournament: { name: string } | null;
};
type Detection = {
  id: string;
  captured_at: string;
  detected_phase: string | null;
  detected_payload: { confidence?: number; team_names_visible?: string[] } | null;
};

export default function StreamsPage() {
  const [tournaments, setTournaments] = useState<Option[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [recentDetections, setRecentDetections] = useState<Record<string, Detection>>({});

  const [url, setUrl] = useState("");
  const [tournamentId, setTournamentId] = useState("");
  const [overlayTemplate, setOverlayTemplate] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadTournaments() {
    const { data } = await supabase.from("tournaments").select("id, name").order("name");
    setTournaments((data ?? []).map((t) => ({ id: t.id, label: t.name })));
  }

  async function loadStreams() {
    const { data } = await supabase
      .from("streams")
      .select(
        `id, url, platform, status, overlay_template, current_match_id,
         tournament:tournaments(name)`
      )
      .order("created_at", { ascending: false });
    setStreams((data as unknown as Stream[]) ?? []);

    // Grab the most recent vision_detections row per stream, so the admin can see
    // what the worker is actually reading without digging into Supabase directly.
    if (data && data.length > 0) {
      const results: Record<string, Detection> = {};
      for (const s of data) {
        const { data: det } = await supabase
          .from("vision_detections")
          .select("id, captured_at, detected_phase, detected_payload")
          .eq("stream_id", s.id)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (det) results[s.id] = det as Detection;
      }
      setRecentDetections(results);
    }
  }

  useEffect(() => {
    loadTournaments();
    loadStreams();
    const interval = setInterval(loadStreams, 10000); // refresh so the "last seen" panel stays current
    return () => clearInterval(interval);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("streams").insert({
      url,
      tournament_id: tournamentId || null,
      overlay_template: overlayTemplate || "default",
      status: "scheduled",
    });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setUrl("");
    setOverlayTemplate("default");
    loadStreams();
  }

  async function endStream(id: string) {
    await supabase.from("streams").update({ status: "ended" }).eq("id", id);
    loadStreams();
  }

  return (
    <div className="text-white space-y-8 max-w-4xl">
      <div>
        <h1 className="text-lg font-bold mb-2">Add a stream for the worker to watch</h1>
        <p className="text-xs text-white/40 mb-4">
          This is what the Groq vision worker actually polls — creating a match alone
          does not start automated tracking. Link matches to this stream below once it's created.
        </p>
        <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="col-span-2 space-y-1">
            <label className="text-xs text-white/50">YouTube livestream URL</label>
            <input
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-white/50">Tournament</label>
            <select
              value={tournamentId}
              onChange={(e) => setTournamentId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-white/50">Overlay hint (optional)</label>
            <input
              value={overlayTemplate}
              onChange={(e) => setOverlayTemplate(e.target.value)}
              placeholder="default, or e.g. 'kill banners top-center in yellow'"
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="col-span-2 bg-signal rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Add stream
          </button>
        </form>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>

      <div>
        <h2 className="text-lg font-bold mb-4">Streams</h2>
        <div className="space-y-3">
          {streams.map((s) => {
            const det = recentDetections[s.id];
            return (
              <div key={s.id} className="border border-white/10 rounded p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold truncate max-w-md">{s.url}</p>
                    <p className="text-xs text-white/40">
                      {s.tournament?.name ?? "No tournament linked"} · overlay: {s.overlay_template}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2 py-1 rounded uppercase ${
                        s.status === "live"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : s.status === "ended"
                          ? "bg-white/10 text-white/40"
                          : "bg-yellow-500/20 text-yellow-400"
                      }`}
                    >
                      {s.status}
                    </span>
                    {s.status !== "ended" && (
                      <button
                        onClick={() => endStream(s.id)}
                        className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                      >
                        End stream
                      </button>
                    )}
                  </div>
                </div>
                {det ? (
                  <p className="text-[11px] text-white/50">
                    Last read {new Date(det.captured_at).toLocaleTimeString()}: phase{" "}
                    <span className="text-white/80">{det.detected_phase}</span>
                    {det.detected_payload?.team_names_visible?.length
                      ? ` · sees: ${det.detected_payload.team_names_visible.join(", ")}`
                      : ""}
                    {typeof det.detected_payload?.confidence === "number"
                      ? ` · confidence ${det.detected_payload.confidence.toFixed(2)}`
                      : ""}
                  </p>
                ) : (
                  <p className="text-[11px] text-white/30">No detections logged yet — worker may not have picked this up.</p>
                )}
              </div>
            );
          })}
          {streams.length === 0 && <p className="text-white/30 text-sm">No streams added yet.</p>}
        </div>
      </div>
    </div>
  );
}
