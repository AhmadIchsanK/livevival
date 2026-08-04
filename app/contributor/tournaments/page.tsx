"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { buildFieldDiff, getCurrentContributorId, submitEditRequest } from "@/lib/editRequests";

type Tournament = {
  id: string;
  name: string;
  tier: string | null;
  liquipedia_slug: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
};
const FIELDS = ["name", "tier", "liquipedia_slug", "start_date", "end_date", "logo_url"];
const EMPTY: Record<string, unknown> = Object.fromEntries(FIELDS.map((f) => [f, null]));

export default function ContributorTournamentsPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedId, setSelectedId] = useState<string>("new");
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [form, setForm] = useState({ name: "", tier: "", liquipedia_slug: "", start_date: "", end_date: "", logo_url: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("tournaments")
      .select("id, name, tier, liquipedia_slug, start_date, end_date, logo_url")
      .order("name")
      .then(({ data }) => setTournaments((data as Tournament[]) ?? []));
  }, []);

  function resetForm() {
    setSelectedId("new");
    setOriginal({});
    setForm({ name: "", tier: "", liquipedia_slug: "", start_date: "", end_date: "", logo_url: "" });
  }

  function selectTournament(id: string) {
    setSelectedId(id);
    if (id === "new") {
      resetForm();
      return;
    }
    const t = tournaments.find((x) => x.id === id);
    if (!t) return;
    setOriginal({
      name: t.name,
      tier: t.tier,
      liquipedia_slug: t.liquipedia_slug,
      start_date: t.start_date,
      end_date: t.end_date,
      logo_url: t.logo_url,
    });
    setForm({
      name: t.name,
      tier: t.tier ?? "",
      liquipedia_slug: t.liquipedia_slug ?? "",
      start_date: t.start_date ?? "",
      end_date: t.end_date ?? "",
      logo_url: t.logo_url ?? "",
    });
  }

  function field(key: keyof typeof form, label: string, type = "text") {
    return (
      <div className="space-y-1">
        <label className="text-xs text-white/50">{label}</label>
        <input
          type={type}
          value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-signal"
        />
      </div>
    );
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
      name: form.name,
      tier: form.tier || null,
      liquipedia_slug: form.liquipedia_slug || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      logo_url: form.logo_url || null,
    };
    const isNew = selectedId === "new";
    const diff = buildFieldDiff(isNew ? EMPTY : original, after, FIELDS);

    if (Object.keys(diff).length === 0) {
      setSubmitting(false);
      setError("No changes to submit.");
      return;
    }

    const { error } = await submitEditRequest({
      entityType: "tournament",
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
      <h1 className="text-xl font-semibold">Tournaments — Edit Request</h1>
      <select
        value={selectedId}
        onChange={(e) => selectTournament(e.target.value)}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white"
      >
        <option value="new">+ New tournament</option>
        {tournaments.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      <form onSubmit={handleSubmit} className="space-y-3 lv-card-flush p-4">
        {field("name", "Name")}
        {field("tier", "Tier")}
        {field("liquipedia_slug", "Liquipedia slug")}
        {field("start_date", "Start date", "date")}
        {field("end_date", "End date", "date")}
        {field("logo_url", "Logo URL")}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-signal">{notice}</p>}
        <button type="submit" disabled={submitting} className="lv-btn-primary w-full">
          {submitting ? "Submitting..." : "Submit edit request"}
        </button>
      </form>
    </div>
  );
}
