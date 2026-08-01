"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Team = { id: string; name: string; short_name: string | null };

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editShortName, setEditShortName] = useState("");

  async function loadTeams() {
    const { data } = await supabase
      .from("teams")
      .select("id, name, short_name")
      .order("name", { ascending: true });
    setTeams((data as Team[]) ?? []);
  }

  useEffect(() => {
    loadTeams();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.short_name ?? "").toLowerCase().includes(q)
    );
  }, [teams, filter]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))
    );
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase
      .from("teams")
      .insert({ name, short_name: shortName || null });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setName("");
    setShortName("");
    loadTeams();
  }

  function startEdit(t: Team) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditShortName(t.short_name ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("teams")
      .update({ name: editName, short_name: editShortName || null })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadTeams();
  }

  function friendlyDeleteError(message: string, label: string) {
    if (message.includes("violates foreign key")) {
      return `Can't delete "${label}" — it's still used by one or more matches. Remove those matches first.`;
    }
    return message;
  }

  async function deleteTeam(id: string, teamName: string) {
    if (!confirm(`Delete "${teamName}"? This can't be undone.`)) return;
    const { error } = await supabase.from("teams").delete().eq("id", id);
    if (error) {
      setError(friendlyDeleteError(error.message, teamName));
      return;
    }
    loadTeams();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected team(s)? This can't be undone.`)) return;

    const { error } = await supabase.from("teams").delete().in("id", Array.from(selected));
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? "Some selected teams are still used by matches and couldn't be deleted. Remove those matches first."
          : error.message
      );
    }
    setSelected(new Set());
    loadTeams();
  }

  return (
    <div className="text-white space-y-6 max-w-2xl">
      <h1 className="lv-heading text-lg">Teams</h1>

      <form onSubmit={handleAdd} className="flex gap-3 items-end">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-white/50">Team name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. RRQ Hoshi"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
          />
        </div>
        <div className="w-32 space-y-1">
          <label className="text-xs text-white/50">Short name</label>
          <input
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            placeholder="RRQ"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="lv-btn-primary !py-2"
        >
          Add
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between gap-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name..."
          className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
        />
        {selected.size > 0 && (
          <button
            onClick={bulkDelete}
            className="lv-btn-danger whitespace-nowrap"
          >
            Delete {selected.size} selected
          </button>
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
            <th className="font-normal pb-2">Name</th>
            <th className="font-normal pb-2">Short</th>
            <th className="font-normal pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => (
            <tr key={t.id} className="border-t border-white/10">
              {editingId === t.id ? (
                <>
                  <td className="py-2" />
                  <td className="py-2 pr-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={editShortName}
                      onChange={(e) => setEditShortName(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => saveEdit(t.id)} className="lv-btn-primary !px-2 !py-1">
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
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelected(t.id)}
                    />
                  </td>
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 text-white/60">{t.short_name}</td>
                  <td className="py-2 text-right space-x-2">
                    <button
                      onClick={() => startEdit(t)}
                      className="lv-btn-ghost !px-2 !py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteTeam(t.id, t.name)}
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
            <tr><td colSpan={4} className="py-4 text-white/30 text-center">No teams match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
