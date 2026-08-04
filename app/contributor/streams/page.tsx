"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { buildFieldDiff, getCurrentContributorId, submitEditRequest } from "@/lib/editRequests";

type Stream = { id: string; url: string; tournament_id: string | null; overlay_template: string | null };
type Tournament = { id: string; name: string };
const FIELDS = ["url", "tournament_id", "overlay_template"];

export default function ContributorStreamsPage() {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [url, setUrl] = useState("");
  const [tournamentId, setTournamentId] = useState("");
  const [overlayTemplate, setOverlayTemplate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("streams")
      .select("id, url, tournament_id, overlay_template")
      .order("url")
      .then(({ data }) => setStreams((data as Stream[]) ?? []));
    supabase
      .from("tournaments")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTournaments((data as Tournament[]) ?? []));
  }, []);

  function resetForm() {
    setSelectedId("new");
    setOriginal({});
    setUrl("");
    setTournamentId("");
    setOverlayTemplate("");
  }

  function selectStream(id: string) {
    setSelectedId(id);
    if (id === "new") {
      resetForm();
      return;
    }
    const s = streams.find((x) => x.id === id);
    if (!s) return;
    setOriginal({ url: s.url, tournament_id: s.tournament_id, overlay_template: s.overlay_template });
    setUrl(s.url);
    setTournamentId(s.tournament_id ?? "");
    setOverlayTemplate(s.overlay_template ?? "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);

    const contributorId = await getCurrentContributorId();
    if (!contributorId) {
      setSubmitting(false);
      setError("Not signed in as a contributor.");
      return;
    }

    const after = { url, tournament_id: tournamentId || null, overlay_template: overlayTemplate || null };
    const isNew = selectedId === "new";
    const diff = isNew
      ? buildFieldDiff({ url: null, tournament_id: null, overlay_template: null }, after, FIELDS)
      : buildFieldDiff(original, after, FIELDS);

    if (Object.keys(diff).length === 0) {
      setSubmitting(false);
      setError("No changes to submit.");
      return;
    }

    const { error } = await submitEditRequest({
      entityType: "stream",
      entityId: isNew ? null : selectedId,
      action: isNew ? "create" : "update",
      proposedChanges: diff,
      contributorId,
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNotice("Edit request submitted for review.");
    resetForm();
  }

  return (
    <div className="text-white space-y-4 max-w-2xl">
      <h1 className="text-xl font-semibold">Streams — Edit Request</h1>
      <select
        value={selectedId}
        onChange={(e) => selectStream(e.target.value)}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
      >
        <option value="new">+ New stream</option>
        {streams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.url}
          </option>
        ))}
      </select>

      <form onSubmit={handleSubmit} className="space-y-3 lv-card-flush p-4">
        <div className="space-y-1">
          <label className="text-xs text-white/50">URL</label>
          <input
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Tournament</label>
          <select
            value={tournamentId}
            onChange={(e) => setTournamentId(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
          >
            <option value="">None</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Overlay template</label>
          <input
            value={overlayTemplate}
            onChange={(e) => setOverlayTemplate(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-signal">{notice}</p>}
        <button type="submit" disabled={submitting} className="lv-btn-primary w-full">
          {submitting ? "Submitting..." : "Submit edit request"}
        </button>
      </form>
    </div>
  );
}
