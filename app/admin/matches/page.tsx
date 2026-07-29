"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };
type Match = {
  id: string;
  scheduled_at: string | null;
  format: string | null;
  status: string;
  youtube_url: string | null;
  tournament: { name: string } | null;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};

export default function MatchesPage() {
  const [tournaments, setTournaments] = useState<Option[]>([]);
  const [teams, setTeams] = useState<Option[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);

  const [tournamentId, setTournamentId] = useState("");
  const [teamAId, setTeamAId] = useState("");
  const [teamBId, setTeamBId] = useState("");
  const [format, setFormat] = useState("BO3");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadOptions() {
    const [{ data: t }, { data: tm }] = await Promise.all([
      supabase.from("tournaments").select("id, name").order("name"),
      supabase.from("teams").select("id, name").order("name"),
    ]);
    setTournaments((t ?? []).map((r) => ({ id: r.id, label: r.name })));
    setTeams((tm ?? []).map((r) => ({ id: r.id, label: r.name })));
  }

  async function loadMatches() {
    const { data, error } = await supabase
      .from("matches")
      .select(
        `id, scheduled_at, format, status, youtube_url,
         tournament:tournaments(name),
         team_a:teams!matches_team_a_id_fkey(name),
         team_b:teams!matches_team_b_id_fkey(name)`
      )
      .order("scheduled_at", { ascending: true });

    if (error) {
      setError(error.message);
      return;
    }
    setMatches((data as unknown as Match[]) ?? []);
  }

  useEffect(() => {
    loadOptions();
    loadMatches();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("matches").insert({
      tournament_id: tournamentId || null,
      team_a_id: teamAId || null,
      team_b_id: teamBId || null,
      format,
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      status: "scheduled",
    });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setTournamentId("");
    setTeamAId("");
    setTeamBId("");
    setScheduledAt("");
    loadMatches();
  }

  async function updateMatch(id: string, fields: Partial<{ status: string; youtube_url: string }>) {
    const { error } = await supabase.from("matches").update(fields).eq("id", id);
    if (error) setError(error.message);
    else loadMatches();
  }

  return (
    <div className="text-white space-y-8 max-w-4xl">
      <div>
        <h1 className="text-lg font-bold mb-4">Create a match</h1>
        <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="col-span-2 space-y-1">
            <label className="text-xs text-white/50">Tournament</label>
            <select
              required
              value={tournamentId}
              onChange={(e) => setTournamentId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="">Select tournament</option>
              {tournaments.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Team A</label>
            <select
              required
              value={teamAId}
              onChange={(e) => setTeamAId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="">Select team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Team B</label>
            <select
              required
              value={teamBId}
              onChange={(e) => setTeamBId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="">Select team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="BO1">BO1</option>
              <option value="BO3">BO3</option>
              <option value="BO5">BO5</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Scheduled time</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="col-span-2 bg-signal rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Create match
          </button>
        </form>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>

      <div>
        <h2 className="text-lg font-bold mb-4">All matches</h2>
        <div className="space-y-3">
          {matches.map((m) => (
            <div key={m.id} className="border border-white/10 rounded p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">
                    {m.team_a?.name ?? "TBD"} vs {m.team_b?.name ?? "TBD"}
                  </p>
                  <p className="text-xs text-white/50">
                    {m.tournament?.name} · {m.format} · {m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : "no time set"}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    m.status === "live"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : m.status === "finished"
                      ? "bg-white/10 text-white/50"
                      : "bg-yellow-500/20 text-yellow-400"
                  }`}
                >
                  {m.status}
                </span>
              </div>

              <div className="flex gap-2 items-center">
                <input
                  defaultValue={m.youtube_url ?? ""}
                  placeholder="YouTube livestream URL"
                  onBlur={(e) => updateMatch(m.id, { youtube_url: e.target.value })}
                  className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-1.5 text-xs"
                />
                <button
                  onClick={() => updateMatch(m.id, { status: "live" })}
                  className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10"
                >
                  Set live
                </button>
                <button
                  onClick={() => updateMatch(m.id, { status: "finished" })}
                  className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10"
                >
                  Set finished
                </button>
                <a
                  href={`/admin/matches/${m.id}/live`}
                  className="text-xs bg-signal rounded px-3 py-1.5 hover:opacity-90"
                >
                  Open live console
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
