"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };
type Stream = {
  id: string;
  url: string;
  platform: string;
  status: string;
  overlay_template: string;
  current_match_id: string | null;
  tournament_id: string | null;
  created_at: string;
  tournament: { name: string } | null;
};
type SortKey = "newest" | "oldest";

// Deterministic YouTube thumbnail URL — no API call/quota needed, works for
// any public video the moment it's uploaded (even before a livestream goes
// live, YouTube serves a placeholder here).
function youtubeVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Resolution fallback chain, highest to lowest. i.ytimg.com serves these as
// static files per-video — not every video has a maxresdefault/sddefault
// generated (it 404s when absent), so a thumbnail requested at a resolution
// the video doesn't have would otherwise just render broken. hqdefault and
// below are effectively always present (YouTube serves a grey placeholder
// rather than 404ing), so the chain is guaranteed to resolve to *something*
// displayable for any real video id.
const THUMBNAIL_RES_CHAIN = ["maxresdefault", "sddefault", "hqdefault", "mqdefault", "default"] as const;

function youtubeThumbnailUrlAt(videoId: string, resIndex: number): string {
  const res = THUMBNAIL_RES_CHAIN[Math.min(resIndex, THUMBNAIL_RES_CHAIN.length - 1)];
  return `https://i.ytimg.com/vi/${videoId}/${res}.jpg`;
}

// Thumbnail <img> that starts at the highest resolution and steps down the
// chain on each 404 (onError), instead of hardcoding one resolution and
// risking a broken-image icon for videos without a maxres/sd thumbnail. If
// every step in the chain fails (shouldn't happen for a real video id, but
// covers deleted/never-existed ones) it swaps to an explicit "no preview"
// placeholder rather than leaving a broken <img>.
function YoutubeThumbnail({ url, className }: { url: string; className: string }) {
  const videoId = youtubeVideoId(url);
  const [resIndex, setResIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    setResIndex(0);
    setExhausted(false);
  }, [videoId]);

  if (!videoId) return null;

  if (exhausted) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-white/5 text-white/30 text-[9px] text-center leading-tight px-1`}
      >
        No preview
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={youtubeThumbnailUrlAt(videoId, resIndex)}
      alt=""
      className={className}
      onError={() => {
        setResIndex((i) => {
          if (i + 1 < THUMBNAIL_RES_CHAIN.length) return i + 1;
          setExhausted(true);
          return i;
        });
      }}
    />
  );
}

export default function StreamsPage() {
  const [tournaments, setTournaments] = useState<Option[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "scheduled" | "live" | "ended">("all");
  const [tournamentFilter, setTournamentFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [url, setUrl] = useState("");
  const [tournamentId, setTournamentId] = useState("");
  const [overlayTemplate, setOverlayTemplate] = useState("default");
  const [titleFetching, setTitleFetching] = useState(false);
  const [titleFetchError, setTitleFetchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadTournaments() {
    const { data } = await supabase.from("tournaments").select("id, name").order("name");
    setTournaments((data ?? []).map((t) => ({ id: t.id, label: t.name })));
  }

  async function loadStreams() {
    const { data, error } = await supabase
      .from("streams")
      .select(
        `id, url, platform, status, overlay_template, current_match_id, tournament_id, created_at,
         tournament:tournaments(name)`
      )
      .order("created_at", { ascending: false });
    if (error) {
      setError(error.message);
      return;
    }
    setStreams((data as unknown as Stream[]) ?? []);
  }

  // Pre-fills the overlay hint with the video's real YouTube title so the
  // admin doesn't have to type it by hand — still freely editable after.
  // Best-effort (a failure here never blocks adding the stream — the admin
  // can always type the overlay hint by hand), but the failure itself is
  // surfaced inline rather than swallowed, so a bad/expired URL or a
  // malformed YouTube response doesn't just look like nothing happened.
  async function fetchTitleInto(videoUrl: string, apply: (title: string) => void) {
    if (!youtubeVideoId(videoUrl)) return;
    setTitleFetching(true);
    setTitleFetchError(null);
    try {
      const res = await fetch(`/api/youtube-title?url=${encodeURIComponent(videoUrl)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.title !== "string" || !data.title.trim()) {
        setTitleFetchError(
          (data && typeof data.error === "string" && data.error) ||
            "Couldn't extract a title from that video — enter one manually."
        );
        return;
      }
      apply(data.title);
    } catch {
      setTitleFetchError("Couldn't reach YouTube to fetch the title — enter one manually.");
    } finally {
      setTitleFetching(false);
    }
  }

  // Every stream must show a real title + thumbnail, never fall back to a
  // bare link — streams added before title auto-fetch existed (or added via
  // a path that skipped it) are still stuck on the "default" placeholder.
  // Runs once per stream id (not on every 10s poll below) so it never
  // re-hits the YouTube API for streams it already backfilled or that
  // simply failed once.
  const backfilledRef = useRef<Set<string>>(new Set());
  async function backfillMissingTitles(list: Stream[]) {
    const missing = list.filter(
      (s) => (!s.overlay_template || s.overlay_template === "default") && !backfilledRef.current.has(s.id)
    );
    for (const s of missing) {
      backfilledRef.current.add(s.id);
      try {
        const res = await fetch(`/api/youtube-title?url=${encodeURIComponent(s.url)}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.title) {
          await supabase.from("streams").update({ overlay_template: data.title }).eq("id", s.id);
          setStreams((prev) => prev.map((x) => (x.id === s.id ? { ...x, overlay_template: data.title } : x)));
        }
      } catch {
        // Best-effort — leaves the stream on "default" (URL fallback still
        // shown), retried next time this page loads.
      }
    }
  }

  useEffect(() => {
    loadTournaments();
    loadStreams();
  }, []);

  useEffect(() => {
    const interval = setInterval(loadStreams, 10000); // refresh so the "last seen" panel stays current
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    backfillMissingTitles(streams);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams.length]);

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
    const { error } = await supabase.from("streams").update({ status: "ended" }).eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    loadStreams();
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editTournamentId, setEditTournamentId] = useState("");
  const [editOverlay, setEditOverlay] = useState("");

  function startEdit(s: Stream) {
    setEditingId(s.id);
    setEditUrl(s.url);
    setEditTournamentId(s.tournament_id ?? "");
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

  const filteredStreams = streams
    .filter((s) => statusFilter === "all" || s.status === statusFilter)
    .filter((s) => !tournamentFilter || s.tournament_id === tournamentFilter)
    .sort((a, b) =>
      sortKey === "newest" ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at)
    );

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filteredStreams.length ? new Set() : new Set(filteredStreams.map((s) => s.id))
    );
  }

  return (
    <div className="text-white space-y-8 max-w-6xl">
      <div>
        <h1 className="lv-heading text-lg mb-2">Add a livestream / VOD link</h1>
        <p className="text-xs text-white/40 mb-4">
          Streams are just the embeddable YouTube link(s) shown on a match's public page —
          they don't drive automation. Live match state/score comes from the always-on Liquipedia
          poller (per tournament) or, for a match switched to local OCR, from the admin's live
          console. Link a stream to a match on the Matches page once it's created here. Status
          (scheduled/live/ended) now updates automatically once linked — live the moment its match
          goes live, ended once every match linked to it is finished. &quot;End stream&quot; below is
          still there for edge cases (no match linked yet, correcting a mistake) but a status change
          on the linked match will override it again.
        </p>
        <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="col-span-2 space-y-1">
            <label className="text-xs text-white/50">YouTube livestream URL</label>
            <div className="flex gap-2 items-start">
              <input
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => {
                  if (overlayTemplate === "default" || !overlayTemplate) {
                    fetchTitleInto(url, setOverlayTemplate);
                  }
                }}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
              />
              <YoutubeThumbnail
                url={url}
                className="w-20 h-11 rounded object-cover border border-white/10 shrink-0"
              />
            </div>
            {titleFetching && <p className="text-[10px] text-white/40">Fetching title from YouTube...</p>}
            {titleFetchError && <p className="text-[10px] text-red-400">{titleFetchError}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-white/50">Tournament</label>
            <select
              value={tournamentId}
              onChange={(e) => setTournamentId(e.target.value)}
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-white/50">Overlay hint (auto-filled from YouTube title, editable)</label>
            <input
              value={overlayTemplate}
              onChange={(e) => setOverlayTemplate(e.target.value)}
              placeholder="default, or e.g. 'kill banners top-center in yellow'"
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
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
          <div className="flex items-center gap-2 flex-wrap">
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
            <select
              value={tournamentFilter}
              onChange={(e) => setTournamentFilter(e.target.value)}
              className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value="">All tournaments</option>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
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
                      onBlur={() => {
                        if (editUrl !== s.url) fetchTitleInto(editUrl, setEditOverlay);
                      }}
                      className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
                    />
                    <div className="flex gap-2">
                      <select
                        value={editTournamentId}
                        onChange={(e) => setEditTournamentId(e.target.value)}
                        className="flex-1 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                      >
                        <option value="">No tournament</option>
                        {tournaments.map((t) => (
                          <option key={t.id} value={t.id}>{t.label}</option>
                        ))}
                      </select>
                      <input
                        value={editOverlay}
                        onChange={(e) => setEditOverlay(e.target.value)}
                        className="flex-1 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
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
                      <YoutubeThumbnail
                        url={s.url}
                        className="w-20 h-11 rounded object-cover border border-white/10 shrink-0"
                      />
                      <div>
                        <p className="text-sm font-semibold truncate max-w-md">
                          {s.overlay_template && s.overlay_template !== "default" ? s.overlay_template : s.url}
                        </p>
                        <p className="text-xs text-white/40 truncate max-w-md">
                          {s.tournament?.name ?? "No tournament linked"} ·{" "}
                          <a href={s.url} target="_blank" className="hover:text-signal underline">
                            {s.url}
                          </a>
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
