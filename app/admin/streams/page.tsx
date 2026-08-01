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
export default function StreamsPage() {
  const [tournaments, setTournaments] = useState<Option[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "scheduled" | "live" | "ended">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editTournamentId, setEditTournamentId] = useState("");
  const [editOverlay, setEditOverlay] = useState("");

  function startEdit(s: Stream) {
    setEditingId(s.id);
    setEditUrl(s.url);
    setEditTournamentId(tournaments.find((t) => t.label === s.tournament?.name)?.id ?? "");
    setEditOverlay(s.overlay_template);
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("streams")
      .update({ url: editUrl, tournament_id: editTournamentId || null, overlay_template: editOverlay || "default" })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadStreams();
  }

  async function deleteStream(id: string) {
    if (!confirm("Delete this stream? Any matches linked to it will need a new stream assigned.")) return;
    const { error } = await supabase.from("streams").delete().eq("id", id);
    if (error) {
      if (error.message.includes("violates foreign key")) {
        setError("Can't delete — one or more matches are still linked to this stream. Unlink them first on the Matches page.");
      } else {
        setError(error.message);
      }
      return;
    }
    loadStreams();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected stream(s)? Any linked matches will need a new stream assigned.`)) return;

    const { error } = await supabase.from("streams").delete().in("id", Array.from(selected));
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? "Some selected streams are still linked to matches and couldn't be deleted. Unlink them first."
          : error.message
      );
    }
    setSelected(new Set());
    loadStreams();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredStreams = streams.filter((s) => statusFilter === "all" || s.status === statusFilter);

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filteredStreams.length ? new Set() : new Set(filteredStreams.map((s) => s.id))
    );
  }

  return (
    <div className="text-white space-y-8 max-w-4xl">
      <div>
        <h1 className="lv-heading text-lg mb-2">Add a livestream / VOD link</h1>
        <p className="text-xs text-white/40 mb-4">
          Streams are just the embeddable YouTube link(s) shown on a match's public page —
          they don't drive automation. Live match state/score comes from the always-on Liquipedia
          poller (per tournament) or, for a match switched to local OCR, from the admin's live
          console. Link a stream to a match on the Matches page once it's created here.
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
            className="col-span-2 lv-btn-primary !py-2"
          >
            Add stream
          </button>
        </form>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="lv-heading text-lg">Streams</h2>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 text-xs">
              {(["all", "scheduled", "live", "ended"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-2 py-1 rounded uppercase ${
                    statusFilter === s ? "bg-signal" : "border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            {selected.size > 0 && (
              <button
                onClick={bulkDelete}
                className="lv-btn-danger whitespace-nowrap"
              >
                Delete {selected.size} selected
              </button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <input
            type="checkbox"
            checked={filteredStreams.length > 0 && selected.size === filteredStreams.length}
            onChange={toggleSelectAll}
          />
          Select all
        </label>
        <div className="space-y-3">
          {filteredStreams.map((s) => {
            const isEditing = editingId === s.id;
            return (
              <div key={s.id} className="border border-white/10 rounded p-4 space-y-2">
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
                    />
                    <div className="flex gap-2">
                      <select
                        value={editTournamentId}
                        onChange={(e) => setEditTournamentId(e.target.value)}
                        className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                      >
                        <option value="">No tournament</option>
                        {tournaments.map((t) => (
                          <option key={t.id} value={t.id}>{t.label}</option>
                        ))}
                      </select>
                      <input
                        value={editOverlay}
                        onChange={(e) => setEditOverlay(e.target.value)}
                        className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit(s.id)} className="lv-btn-primary">
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="lv-btn-ghost"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                      />
                      <div>
                        <p className="text-sm font-semibold truncate max-w-md">{s.url}</p>
                        <p className="text-xs text-white/40">
                          {s.tournament?.name ?? "No tournament linked"} · overlay: {s.overlay_template}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={s.status === "live" ? "lv-badge-live" : s.status === "ended" ? "lv-badge-finished" : "lv-badge-scheduled"}>
                        {s.status}
                      </span>
                      {s.status !== "ended" && (
                        <button
                          onClick={() => endStream(s.id)}
                          className="lv-btn-ghost !px-2 !py-1"
                        >
                          End stream
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(s)}
                        className="lv-btn-ghost !px-2 !py-1"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteStream(s.id)}
                        className="lv-btn-danger !px-2 !py-1"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filteredStreams.length === 0 && <p className="text-white/30 text-sm">No streams match.</p>}
        </div>
      </div>
    </div>
  );
}
