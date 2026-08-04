"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { buildFieldDiff, getCurrentContributorId, submitEditRequest } from "@/lib/editRequests";

type Match = {
  id: string;
  tournament_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  format: string | null;
  scheduled_at: string | null;
  status: string;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};
type Team = { id: string; name: string };
type Tournament = { id: string; name: string };
const FIELDS = ["tournament_id", "team_a_id", "team_b_id", "format", "scheduled_at"];

// Field-level edits only (tournament/teams/format/schedule) — correcting a
// finished match's live scoreboard/picks/moments goes through the live
// console's own contributor mode instead (entity_type='match_live_edit'),
// not this flat form.
export default function ContributorMatchesPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [form, setForm] = useState({ tournament_id: "", team_a_id: "", team_b_id: "", format: "", scheduled_at: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("matches")
      .select("id, tournament_id, team_a_id, team_b_id, format, scheduled_at, status, team_a:teams!matches_team_a_id_fkey(name), team_b:teams!matches_team_b_id_fkey(name)")
      .order("scheduled_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        const rows = (data as unknown as Match[]) ?? [];
        setMatches(rows.map((m) => ({ ...m, team_a: Array.isArray(m.team_a) ? m.team_a[0] : m.team_a, team_b: Array.isArray(m.team_b) ? m.team_b[0] : m.team_b })));
      });
    supabase.from("teams").select("id, name").order("name").then(({ data }) => setTeams((data as Team[]) ?? []));
    supabase.from("tournaments").select("id, name").order("name").then(({ data }) => setTournaments((data as Tournament[]) ?? []));
  }, []);

  function resetForm() {
    setSelectedId("new");
    setOriginal({});
    setForm({ tournament_id: "", team_a_id: "", team_b_id: "", format: "", scheduled_at: "" });
  }

  function selectMatch(id: string) {
    setSelectedId(id);
    if (id === "new") {
      resetForm();
      return;
    }
    const m = matches.find((x) => x.id === id);
    if (!m) return;
    setOriginal({
      tournament_id: m.tournament_id,
      team_a_id: m.team_a_id,
      team_b_id: m.team_b_id,
      format: m.format,
      scheduled_at: m.scheduled_at,
    });
    setForm({
      tournament_id: m.tournament_id ?? "",
      team_a_id: m.team_a_id ?? "",
      team_b_id: m.team_b_id ?? "",
      format: m.format ?? "",
      scheduled_at: m.scheduled_at ? m.scheduled_at.slice(0, 16) : "",
    });
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

    const after: Record<string, unknown> = {
      tournament_id: form.tournament_id || null,
      team_a_id: form.team_a_id || null,
      team_b_id: form.team_b_id || null,
      format: form.format || null,
      scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
    };
    const isNew = selectedId === "new";
    const diff = buildFieldDiff(
      isNew ? { tournament_id: null, team_a_id: null, team_b_id: null, format: null, scheduled_at: null } : original,
      after,
      FIELDS
    );

    if (Object.keys(diff).length === 0) {
      setSubmitting(false);
      setError("No changes to submit.");
      return;
    }

    const { error } = await submitEditRequest({
      entityType: "match",
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
      <h1 className="text-xl font-semibold">Matches — Edit Request</h1>
      <p className="text-xs text-white/40">
        To correct a finished match's scoreboard, hero picks, or moments, open it from the public site and use the
        live console's contributor mode instead.
      </p>
      <select
        value={selectedId}
        onChange={(e) => selectMatch(e.target.value)}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
      >
        <option value="new">+ New match</option>
        {matches.map((m) => (
          <option key={m.id} value={m.id}>
            {m.team_a?.name ?? "TBD"} vs {m.team_b?.name ?? "TBD"}
          </option>
        ))}
      </select>

      <form onSubmit={handleSubmit} className="space-y-3 lv-card-flush p-4">
        <div className="space-y-1">
          <label className="text-xs text-white/50">Tournament</label>
          <select
            value={form.tournament_id}
            onChange={(e) => setForm((f) => ({ ...f, tournament_id: e.target.value }))}
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
        <div className="flex gap-2">
          <div className="space-y-1 flex-1">
            <label className="text-xs text-white/50">Team A</label>
            <select
              value={form.team_a_id}
              onChange={(e) => setForm((f) => ({ ...f, team_a_id: e.target.value }))}
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              <option value="">TBD</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 flex-1">
            <label className="text-xs text-white/50">Team B</label>
            <select
              value={form.team_b_id}
              onChange={(e) => setForm((f) => ({ ...f, team_b_id: e.target.value }))}
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
            >
              <option value="">TBD</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Format</label>
          <input
            value={form.format}
            onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))}
            placeholder="BO3"
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Scheduled at</label>
          <input
            type="datetime-local"
            value={form.scheduled_at}
            onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-signal">{notice}</p>}
        <button type="submit" disabled={submitting} className="lv-btn-primary w-full">
          {submitting ? "Submitting..." : "Submit edit request"}
        </button>
      </form>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-white/60">Correct a finished match's scoreboard or picks</h2>
        <div className="space-y-1.5">
          {matches
            .filter((m) => m.status === "finished")
            .slice(0, 15)
            .map((m) => (
              <a
                key={m.id}
                href={`/admin/matches/${m.id}/live`}
                className="lv-card-flush flex items-center justify-between px-3 py-2 text-sm hover:border-signal/40 transition-colors"
              >
                <span>
                  {m.team_a?.name ?? "TBD"} vs {m.team_b?.name ?? "TBD"}
                </span>
                <span className="text-signal text-xs">Open live console →</span>
              </a>
            ))}
        </div>
      </div>
    </div>
  );
}
