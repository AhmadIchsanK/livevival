"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { buildFieldDiff, getCurrentContributorId, submitEditRequest } from "@/lib/editRequests";

type Player = { id: string; ign: string; role: string | null; team_id: string | null };
type Team = { id: string; name: string };
const FIELDS = ["ign", "role", "team_id"];

export default function ContributorPlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [ign, setIgn] = useState("");
  const [role, setRole] = useState("");
  const [teamId, setTeamId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("players")
      .select("id, ign, role, team_id")
      .order("ign")
      .then(({ data }) => setPlayers((data as Player[]) ?? []));
    supabase
      .from("teams")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTeams((data as Team[]) ?? []));
  }, []);

  function resetForm() {
    setSelectedId("new");
    setOriginal({});
    setIgn("");
    setRole("");
    setTeamId("");
  }

  function selectPlayer(id: string) {
    setSelectedId(id);
    if (id === "new") {
      resetForm();
      return;
    }
    const p = players.find((x) => x.id === id);
    if (!p) return;
    setOriginal({ ign: p.ign, role: p.role, team_id: p.team_id });
    setIgn(p.ign);
    setRole(p.role ?? "");
    setTeamId(p.team_id ?? "");
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

    const after = { ign, role: role || null, team_id: teamId || null };
    const isNew = selectedId === "new";
    const diff = isNew
      ? buildFieldDiff({ ign: null, role: null, team_id: null }, after, FIELDS)
      : buildFieldDiff(original, after, FIELDS);

    if (Object.keys(diff).length === 0) {
      setSubmitting(false);
      setError("No changes to submit.");
      return;
    }

    const { error } = await submitEditRequest({
      entityType: "player",
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
      <h1 className="text-xl font-semibold">Players — Edit Request</h1>
      <select
        value={selectedId}
        onChange={(e) => selectPlayer(e.target.value)}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
      >
        <option value="new">+ New player</option>
        {players.map((p) => (
          <option key={p.id} value={p.id}>
            {p.ign}
          </option>
        ))}
      </select>

      <form onSubmit={handleSubmit} className="space-y-3 lv-card-flush p-4">
        <div className="space-y-1">
          <label className="text-xs text-white/50">IGN</label>
          <input
            required
            value={ign}
            onChange={(e) => setIgn(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Role</label>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Team</label>
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
          >
            <option value="">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
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
