"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Team = { id: string; name: string; short_name: string | null; logo_url: string | null };
type SortKey = "name" | "name_desc";

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editShortName, setEditShortName] = useState("");
  const [editLogoUrl, setEditLogoUrl] = useState("");

  const [mergeTargetId, setMergeTargetId] = useState("");
  const [merging, setMerging] = useState(false);

  async function loadTeams() {
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, short_name, logo_url")
      .order("name", { ascending: true });
    if (error) {
      setError(error.message);
      return;
    }
    setTeams((data as Team[]) ?? []);
  }

  useEffect(() => {
    loadTeams();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = !q
      ? teams
      : teams.filter(
          (t) => t.name.toLowerCase().includes(q) || (t.short_name ?? "").toLowerCase().includes(q)
        );
    const sorted = [...base].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [teams, filter, sortKey]);

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
      .insert({ name, short_name: shortName || null, logo_url: logoUrl || null });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setName("");
    setShortName("");
    setLogoUrl("");
    loadTeams();
  }

  function startEdit(t: Team) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditShortName(t.short_name ?? "");
    setEditLogoUrl(t.logo_url ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("teams")
      .update({ name: editName, short_name: editShortName || null, logo_url: editLogoUrl || null })
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

  // Reassigns every match/player/result FK from each selected team onto
  // mergeTargetId, then deletes the selected teams — for consolidating
  // duplicate imports (e.g. "ONIC" vs "ONIC Esports" from different
  // Liquipedia team-template titles) without losing history.
  async function mergeSelected() {
    if (selected.size === 0 || !mergeTargetId) return;
    if (selected.has(mergeTargetId)) {
      setError("Merge target can't be one of the selected teams — deselect it first.");
      return;
    }
    const sourceIds = Array.from(selected);
    const sourceNames = teams.filter((t) => sourceIds.includes(t.id)).map((t) => t.name).join(", ");
    const targetName = teams.find((t) => t.id === mergeTargetId)?.name ?? "target";
    if (
      !confirm(
        `Merge ${sourceIds.length} team(s) (${sourceNames}) into "${targetName}"? ` +
          `All their matches, players, and results move to "${targetName}", then the merged teams are deleted. This can't be undone.`
      )
    ) {
      return;
    }

    setMerging(true);
    setError(null);
    setNotice(null);
    let failures = 0;
    for (const sourceId of sourceIds) {
      const { error } = await supabase.rpc("merge_teams", { source_id: sourceId, target_id: mergeTargetId });
      if (error) {
        failures += 1;
        console.error(`Failed to merge team ${sourceId} into ${mergeTargetId}:`, error.message);
      }
    }
    setMerging(false);
    setSelected(new Set());
    setMergeTargetId("");
    if (failures > 0) {
      setError(`${failures} of ${sourceIds.length} merge(s) failed — check console for details.`);
    } else {
      setNotice(`Merged ${sourceIds.length} team(s) into "${targetName}".`);
    }
    loadTeams();
  }

  return (
    <div className="text-white space-y-6 max-w-2xl">
      <h1 className="lv-heading text-lg">Teams</h1>

      <form onSubmit={handleAdd} className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-[160px] space-y-1">
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
        <div className="flex-1 min-w-[200px] space-y-1">
          <label className="text-xs text-white/50">Logo URL</label>
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://..."
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
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1 min-w-[200px]">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name..."
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="name">Name A→Z</option>
            <option value="name_desc">Name Z→A</option>
          </select>
        </div>
        {selected.size > 0 && (
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={mergeTargetId}
              onChange={(e) => setMergeTargetId(e.target.value)}
              className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
            >
              <option value="">Merge into...</option>
              {teams
                .filter((t) => !selected.has(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
            </select>
            <button
              onClick={mergeSelected}
              disabled={!mergeTargetId || merging}
              className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap"
            >
              {merging ? "Merging..." : `Merge ${selected.size} into target`}
            </button>
            <button
              onClick={bulkDelete}
              className="lv-btn-danger whitespace-nowrap"
            >
              Delete {selected.size} selected
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
            <th className="font-normal pb-2 w-10">Logo</th>
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
                    {editLogoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={editLogoUrl} alt="" className="w-6 h-6 rounded object-cover" />
                    ) : (
                      <span className="text-white/20">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2 space-y-1">
                    <input
                      value={editShortName}
                      onChange={(e) => setEditShortName(e.target.value)}
                      placeholder="Short name"
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                    <input
                      value={editLogoUrl}
                      onChange={(e) => setEditLogoUrl(e.target.value)}
                      placeholder="Logo URL"
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
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
                  <td className="py-2">
                    {t.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.logo_url} alt="" className="w-6 h-6 rounded object-cover" />
                    ) : (
                      <span className="text-white/20">—</span>
                    )}
                  </td>
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 text-white/60">{t.short_name ?? "—"}</td>
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
            <tr><td colSpan={5} className="py-4 text-white/30 text-center">No teams match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
