"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Hero = {
  id: string;
  name: string;
  role: string | null;
  icon_url: string | null;
  aliases: string[];
  liquipedia_slug: string | null;
};

function parseAliases(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function HeroesPage() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [aliases, setAliases] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editIconUrl, setEditIconUrl] = useState("");
  const [editAliases, setEditAliases] = useState("");

  const [bulkText, setBulkText] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);

  async function loadHeroes() {
    const { data } = await supabase
      .from("heroes")
      .select("id, name, role, icon_url, aliases, liquipedia_slug")
      .order("name", { ascending: true });
    setHeroes((data as Hero[]) ?? []);
  }

  useEffect(() => {
    loadHeroes();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return heroes;
    return heroes.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.role ?? "").toLowerCase().includes(q) ||
        h.aliases.some((a) => a.toLowerCase().includes(q))
    );
  }, [heroes, filter]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((h) => h.id))));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("heroes").insert({
      name,
      role: role || null,
      icon_url: iconUrl || null,
      aliases: parseAliases(aliases),
    });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setName("");
    setRole("");
    setIconUrl("");
    setAliases("");
    loadHeroes();
  }

  function startEdit(h: Hero) {
    setEditingId(h.id);
    setEditName(h.name);
    setEditRole(h.role ?? "");
    setEditIconUrl(h.icon_url ?? "");
    setEditAliases(h.aliases.join(", "));
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("heroes")
      .update({
        name: editName,
        role: editRole || null,
        icon_url: editIconUrl || null,
        aliases: parseAliases(editAliases),
      })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadHeroes();
  }

  function friendlyDeleteError(message: string, label: string) {
    if (message.includes("violates foreign key")) {
      return `Can't delete "${label}" — it's still referenced by pick/ban or stat rows.`;
    }
    return message;
  }

  async function deleteHero(id: string, heroName: string) {
    if (!confirm(`Delete "${heroName}"? This can't be undone.`)) return;
    const { error } = await supabase.from("heroes").delete().eq("id", id);
    if (error) {
      setError(friendlyDeleteError(error.message, heroName));
      return;
    }
    loadHeroes();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected hero(es)? This can't be undone.`)) return;
    const { error } = await supabase.from("heroes").delete().in("id", Array.from(selected));
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? "Some selected heroes are still referenced by pick/ban or stat rows and couldn't be deleted."
          : error.message
      );
    }
    setSelected(new Set());
    loadHeroes();
  }

  // Bulk import: one hero per line, "Name, Role, IconUrl" (Role/IconUrl optional).
  async function bulkImport() {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setBulkLoading(true);
    setError(null);

    for (const line of lines) {
      const [n, r, icon] = line.split(",").map((s) => s.trim());
      if (!n) continue;
      const { error } = await supabase
        .from("heroes")
        .upsert({ name: n, role: r || null, icon_url: icon || null }, { onConflict: "name" });
      if (error) console.error(`Failed to import "${n}":`, error.message);
    }

    setBulkLoading(false);
    setBulkText("");
    loadHeroes();
  }

  return (
    <div className="text-white space-y-6 max-w-3xl">
      <div>
        <h1 className="text-lg font-bold">Heroes</h1>
        <p className="text-xs text-white/40 mt-1">
          Auto-imported from Liquipedia every 6h (name + icon). Edit role/aliases here, or add anything the
          importer missed.
        </p>
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-2 gap-3 max-w-xl">
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Hero name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Yu Zhong"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Role</label>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Fighter/Tank/..."
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Icon URL</label>
          <input
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            placeholder="https://..."
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Aliases (comma-separated, optional)</label>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="e.g. YZ, Yu-Zhong"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="col-span-2 bg-signal rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Add
        </button>
      </form>

      <details className="border border-white/10 rounded p-3">
        <summary className="text-xs text-white/60 cursor-pointer">Bulk import (paste one per line)</summary>
        <div className="mt-3 space-y-2">
          <p className="text-[10px] text-white/40">Format: `Name, Role, IconUrl` — Role and IconUrl are optional.</p>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={5}
            placeholder={"Yu Zhong, Fighter, https://...\nGusion, Assassin"}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-xs font-mono"
          />
          <button
            onClick={bulkImport}
            disabled={bulkLoading || !bulkText.trim()}
            className="text-xs bg-signal rounded px-3 py-1.5 disabled:opacity-50"
          >
            {bulkLoading ? "Importing..." : "Import"}
          </button>
        </div>
      </details>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between gap-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, role, or alias..."
          className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
        />
        {selected.size > 0 && (
          <button
            onClick={bulkDelete}
            className="text-xs border border-red-500/30 text-red-300 rounded px-3 py-1.5 hover:bg-red-500/10 whitespace-nowrap"
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
            <th className="font-normal pb-2 w-10"></th>
            <th className="font-normal pb-2">Name</th>
            <th className="font-normal pb-2">Role</th>
            <th className="font-normal pb-2">Aliases</th>
            <th className="font-normal pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((h) => (
            <tr key={h.id} className="border-t border-white/10">
              {editingId === h.id ? (
                <>
                  <td className="py-2" colSpan={2} />
                  <td className="py-2 pr-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
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
                    <input
                      value={editAliases}
                      onChange={(e) => setEditAliases(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                    <input
                      value={editIconUrl}
                      onChange={(e) => setEditIconUrl(e.target.value)}
                      placeholder="Icon URL"
                      className="w-full mt-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => saveEdit(h.id)} className="text-xs bg-signal rounded px-2 py-1">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                    >
                      Cancel
                    </button>
                  </td>
                </>
              ) : (
                <>
                  <td className="py-2">
                    <input type="checkbox" checked={selected.has(h.id)} onChange={() => toggleSelected(h.id)} />
                  </td>
                  <td className="py-2">
                    {h.icon_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={h.icon_url} alt={h.name} className="w-8 h-8 rounded object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-white/10" />
                    )}
                  </td>
                  <td className="py-2">{h.name}</td>
                  <td className="py-2 text-white/60">{h.role ?? "—"}</td>
                  <td className="py-2 text-white/40 text-xs">{h.aliases.join(", ") || "—"}</td>
                  <td className="py-2 text-right space-x-2">
                    <button
                      onClick={() => startEdit(h)}
                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteHero(h.id, h.name)}
                      className="text-xs border border-red-500/30 text-red-300 rounded px-2 py-1 hover:bg-red-500/10"
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
              <td colSpan={6} className="py-4 text-white/30 text-center">
                No heroes match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
