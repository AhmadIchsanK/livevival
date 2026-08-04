"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { buildFieldDiff, getCurrentContributorId, submitEditRequest } from "@/lib/editRequests";

type Hero = { id: string; name: string; role: string | null; icon_url: string | null; aliases: string[] | null };
const FIELDS = ["name", "role", "icon_url", "aliases"];

function parseAliases(text: string): string[] | null {
  const list = text.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

export default function ContributorHeroesPage() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [aliases, setAliases] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("heroes")
      .select("id, name, role, icon_url, aliases")
      .order("name")
      .then(({ data }) => setHeroes((data as Hero[]) ?? []));
  }, []);

  function resetForm() {
    setSelectedId("new");
    setOriginal({});
    setName("");
    setRole("");
    setIconUrl("");
    setAliases("");
  }

  function selectHero(id: string) {
    setSelectedId(id);
    if (id === "new") {
      resetForm();
      return;
    }
    const h = heroes.find((x) => x.id === id);
    if (!h) return;
    setOriginal({ name: h.name, role: h.role, icon_url: h.icon_url, aliases: h.aliases });
    setName(h.name);
    setRole(h.role ?? "");
    setIconUrl(h.icon_url ?? "");
    setAliases((h.aliases ?? []).join(", "));
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

    const after = { name, role: role || null, icon_url: iconUrl || null, aliases: parseAliases(aliases) };
    const isNew = selectedId === "new";
    const diff = isNew
      ? buildFieldDiff({ name: null, role: null, icon_url: null, aliases: null }, after, FIELDS)
      : buildFieldDiff(original, after, FIELDS);

    if (Object.keys(diff).length === 0) {
      setSubmitting(false);
      setError("No changes to submit.");
      return;
    }

    const { error } = await submitEditRequest({
      entityType: "hero",
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
    <div className="text-white space-y-4 max-w-lg">
      <h1 className="text-xl font-semibold">Heroes — Edit Request</h1>
      <select
        value={selectedId}
        onChange={(e) => selectHero(e.target.value)}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
      >
        <option value="new">+ New hero</option>
        {heroes.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>

      <form onSubmit={handleSubmit} className="space-y-3 lv-card-flush p-4">
        <div className="space-y-1">
          <label className="text-xs text-white/50">Name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
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
          <label className="text-xs text-white/50">Icon URL</label>
          <input
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Aliases (comma-separated)</label>
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
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
