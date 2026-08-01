"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };
type Player = { id: string; ign: string; role: string | null; team_id: string | null; team: { name: string } | null };

export default function PlayersPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [teams, setTeams] = useState<Option[]>([]);
  const [filter, setFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [ign, setIgn] = useState("");
  const [role, setRole] = useState("");
  const [teamId, setTeamId] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editIgn, setEditIgn] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editTeamId, setEditTeamId] = useState("");

  const [bulkTeamId, setBulkTeamId] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);

  async function loadPlayers() {
    const { data } = await supabase
      .from("players")
      .select("id, ign, role, team_id, team:teams(name)")
      .order("ign", { ascending: true });
    setPlayers((data as unknown as Player[]) ?? []);
  }
  async function loadTeams() {
    const { data } = await supabase.from("teams").select("id, name").order("name");
    setTeams((data ?? []).map((t) => ({ id: t.id, label: t.name })));
  }

  useEffect(() => {
    loadPlayers();
    loadTeams();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return players.filter((p) => {
      if (teamFilter && p.team_id !== teamFilter) return false;
      if (!q) return true;
      return p.ign.toLowerCase().includes(q) || (p.team?.name ?? "").toLowerCase().includes(q);
    });
  }, [players, filter, teamFilter]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((p) => p.id))));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("players").insert({ ign, role: role || null, team_id: teamId || null });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setIgn("");
    setRole("");
    setTeamId("");
    loadPlayers();
  }

  function startEdit(p: Player) {
    setEditingId(p.id);
    setEditIgn(p.ign);
    setEditRole(p.role ?? "");
    setEditTeamId(p.team_id ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("players")
      .update({ ign: editIgn, role: editRole || null, team_id: editTeamId || null })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadPlayers();
  }

  function friendlyDeleteError(message: string, label: string) {
    if (message.includes("violates foreign key")) {
      return `Can't delete "${label}" — it's still referenced by pick/ban or stat rows.`;
    }
    return message;
  }

  async function deletePlayer(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    const { error } = await supabase.from("players").delete().eq("id", id);
    if (error) {
      setError(friendlyDeleteError(error.message, name));
      return;
    }
    loadPlayers();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected player(s)? This can't be undone.`)) return;
    const { error } = await supabase.from("players").delete().in("id", Array.from(selected));
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? "Some selected players are still referenced by pick/ban or stat rows and couldn't be deleted."
          : error.message
      );
    }
    setSelected(new Set());
    loadPlayers();
  }

  async function bulkReassignTeam() {
    if (selected.size === 0 || !bulkTeamId) return;
    const { error } = await supabase.from("players").update({ team_id: bulkTeamId }).in("id", Array.from(selected));
    if (error) setError(error.message);
    setSelected(new Set());
    loadPlayers();
  }

  // One IGN per line, optional ", Role" — all go to bulkTeamId.
  async function bulkImport() {
    if (!bulkTeamId) {
      setError("Pick a team for the bulk import first.");
      return;
    }
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setBulkLoading(true);
    setError(null);

    for (const line of lines) {
      const [name, role] = line.split(",").map((s) => s.trim());
      if (!name) continue;
      const { data: existing } = await supabase
        .from("players")
        .select("id")
        .eq("team_id", bulkTeamId)
        .ilike("ign", name)
        .maybeSingle();
      if (existing) continue;
      const { error } = await supabase.from("players").insert({ ign: name, role: role || null, team_id: bulkTeamId });
      if (error) console.error(`Failed to import "${name}":`, error.message);
    }

    setBulkLoading(false);
    setBulkText("");
    loadPlayers();
  }

  return (
    <div className="text-white space-y-6 max-w-3xl">
      <h1 className="lv-heading text-lg">Players</h1>

      <form onSubmit={handleAdd} className="grid grid-cols-3 gap-3 max-w-xl items-end">
        <div className="space-y-1">
          <label className="text-xs text-white/50">IGN</label>
          <input
            required
            value={ign}
            onChange={(e) => setIgn(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Role</label>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Jungler/Gold/..."
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Team</label>
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="">None</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="col-span-3 lv-btn-primary !py-2"
        >
          Add
        </button>
      </form>

      <details className="border border-white/10 rounded p-3">
        <summary className="text-xs text-white/60 cursor-pointer">Bulk import (paste one per line, one team at a time)</summary>
        <div className="mt-3 space-y-2">
          <select
            value={bulkTeamId}
            onChange={(e) => setBulkTeamId(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
          >
            <option value="">Select team...</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-white/40">Format: `IGN, Role` — Role is optional.</p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={5}
            placeholder={"Kairi, Jungler\nAlberttt"}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-xs font-mono"
          />
          <button
            onClick={bulkImport}
            disabled={bulkLoading || !bulkText.trim()}
            className="lv-btn-primary"
          >
            {bulkLoading ? "Importing..." : "Import"}
          </button>
        </div>
      </details>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by IGN or team..."
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        {selected.size > 0 && (
          <div className="flex gap-2 items-center">
            <select
              value={bulkTeamId}
              onChange={(e) => setBulkTeamId(e.target.value)}
              className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
            >
              <option value="">Reassign to team...</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={bulkReassignTeam}
              disabled={!bulkTeamId}
              className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap"
            >
              Apply to {selected.size}
            </button>
            <button
              onClick={bulkDelete}
              className="lv-btn-danger whitespace-nowrap"
            >
              Delete {selected.size}
            </button>
          </div>
        )}
      </div>

      <table className="w-full text-sm">
        <thead className="text-white/40 text-left">
          <tr>
            <th className="font-normal pb-2 w-8">
              <input
                type="checkbox"
                checked={filtered.length > 0 && selected.size === filtered.length}
                onChange={toggleSelectAll}
              />
            </th>
            <th className="font-normal pb-2">IGN</th>
            <th className="font-normal pb-2">Role</th>
            <th className="font-normal pb-2">Team</th>
            <th className="font-normal pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} className="border-t border-white/10">
              {editingId === p.id ? (
                <>
                  <td className="py-2" />
                  <td className="py-2 pr-2">
                    <input
                      value={editIgn}
                      onChange={(e) => setEditIgn(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      value={editTeamId}
                      onChange={(e) => setEditTeamId(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    >
                      <option value="">None</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => saveEdit(p.id)} className="lv-btn-primary !px-2 !py-1">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="lv-btn-ghost !px-2 !py-1"
                    >
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className="py-2">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)} />
                  </td>
                  <td className="py-2">{p.ign}</td>
                  <td className="py-2 text-white/60">{p.role ?? "—"}</td>
                  <td className="py-2 text-white/60">{p.team?.name ?? "—"}</td>
                  <td className="py-2 text-right space-x-2">
                    <button
                      onClick={() => startEdit(p)}
                      className="lv-btn-ghost !px-2 !py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deletePlayer(p.id, p.ign)}
                      className="lv-btn-danger !px-2 !py-1"
                    >
                      Delete
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-white/30 text-center">
                No players match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
