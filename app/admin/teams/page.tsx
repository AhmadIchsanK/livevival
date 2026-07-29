"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Team = { id: string; name: string; short_name: string | null };

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="text-white space-y-6 max-w-2xl">
      <h1 className="text-lg font-bold">Teams</h1>

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
          className="bg-signal rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <table className="w-full text-sm">
        <thead className="text-white/40 text-left">
          <tr>
            <th className="font-normal pb-2">Name</th>
            <th className="font-normal pb-2">Short</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.id} className="border-t border-white/10">
              <td className="py-2">{t.name}</td>
              <td className="py-2 text-white/60">{t.short_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
