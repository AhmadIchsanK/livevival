"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  liquipedia_slug: string | null;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
};

export default function TournamentsAdminPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [filter, setFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [name, setName] = useState("");
  const [tier, setTier] = useState("S");
  const [slug, setSlug] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [logoUrl, setLogoUrl] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTier, setEditTier] = useState("S");
  const [editSlug, setEditSlug] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editLogoUrl, setEditLogoUrl] = useState("");

  async function loadTournaments() {
    const { data } = await supabase
      .from("tournaments")
      .select("id, name, tier, liquipedia_slug, date_display, start_date, end_date, logo_url")
      .order("start_date", { ascending: false, nullsFirst: false });
    setTournaments((data as Tournament[]) ?? []);
  }

  useEffect(() => {
    loadTournaments();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return tournaments.filter((t) => {
      if (tierFilter && t.tier !== tierFilter) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || (t.liquipedia_slug ?? "").toLowerCase().includes(q);
    });
  }, [tournaments, filter, tierFilter]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("tournaments").insert({
      name,
      tier,
      liquipedia_slug: slug || null,
      start_date: startDate || null,
      end_date: endDate || null,
      logo_url: logoUrl || null,
    });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setName("");
    setSlug("");
    setStartDate("");
    setEndDate("");
    setLogoUrl("");
    loadTournaments();
  }

  function startEdit(t: Tournament) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditTier(t.tier);
    setEditSlug(t.liquipedia_slug ?? "");
    setEditStartDate(t.start_date ?? "");
    setEditEndDate(t.end_date ?? "");
    setEditLogoUrl(t.logo_url ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("tournaments")
      .update({
        name: editName,
        tier: editTier,
        liquipedia_slug: editSlug || null,
        start_date: editStartDate || null,
        end_date: editEndDate || null,
        logo_url: editLogoUrl || null,
      })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadTournaments();
  }

  function friendlyDeleteError(message: string, label: string) {
    if (message.includes("violates foreign key")) {
      return `Can't delete "${label}" — it still has matches or streams linked. Remove those first.`;
    }
    return message;
  }

  async function deleteTournament(id: string, tName: string) {
    if (!confirm(`Delete "${tName}"? This can't be undone.`)) return;
    const { error } = await supabase.from("tournaments").delete().eq("id", id);
    if (error) {
      setError(friendlyDeleteError(error.message, tName));
      return;
    }
    loadTournaments();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected tournament(s)? This can't be undone.`)) return;
    const { error } = await supabase.from("tournaments").delete().in("id", Array.from(selected));
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? "Some selected tournaments still have matches or streams linked and couldn't be deleted."
          : error.message
      );
    }
    setSelected(new Set());
    loadTournaments();
  }

  return (
    <div className="text-white space-y-6 max-w-4xl">
      <div>
        <h1 className="lv-heading text-lg">Tournaments</h1>
        <p className="text-xs text-white/40 mt-1">
          S/A-Tier tournaments auto-import from Liquipedia every 6h, scoped to a rolling past year
          (or still upcoming/ongoing). Edit dates/logo here, or add one manually if Liquipedia hasn&apos;t yet.
        </p>
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-2 gap-3 max-w-xl">
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Tier</label>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="S">S</option>
            <option value="A">A</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Liquipedia slug</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. MSC/2026"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">End date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Logo URL</label>
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="col-span-2 lv-btn-primary !py-2"
        >
          Add
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or slug..."
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="">All tiers</option>
            <option value="S">S-Tier</option>
            <option value="A">A-Tier</option>
          </select>
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
            <th className="font-normal pb-2">Tier</th>
            <th className="font-normal pb-2">Dates</th>
            <th className="font-normal pb-2">Slug</th>
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
                    <select
                      value={editTier}
                      onChange={(e) => setEditTier(e.target.value)}
                      className="bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    >
                      <option value="S">S</option>
                      <option value="A">A</option>
                    </select>
                  </td>
                  <td className="py-2 pr-2 space-y-1">
                    <input
                      type="date"
                      value={editStartDate}
                      onChange={(e) => setEditStartDate(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                    <input
                      type="date"
                      value={editEndDate}
                      onChange={(e) => setEditEndDate(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={editSlug}
                      onChange={(e) => setEditSlug(e.target.value)}
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
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelected(t.id)} />
                  </td>
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 text-white/60">{t.tier}-Tier</td>
                  <td className="py-2 text-white/60 text-xs">
                    {t.start_date ?? "?"} → {t.end_date ?? "?"}
                  </td>
                  <td className="py-2 text-white/40 text-xs">{t.liquipedia_slug ?? "—"}</td>
                  <td className="py-2 text-right space-x-2">
                    <button
                      onClick={() => startEdit(t)}
                      className="lv-btn-ghost !px-2 !py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteTournament(t.id, t.name)}
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
              <td colSpan={6} className="py-4 text-white/30 text-center">
                No tournaments match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
