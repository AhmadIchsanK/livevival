"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };
type Match = {
  id: string;
  scheduled_at: string | null;
  format: string | null;
  status: string;
  youtube_url: string | null;
  state: string;
  stream_id: string | null;
  auto_managed: boolean;
  tournament_id: string | null;
  team_a_id: string | null;
  team_b_id: string | null;
  tournament: { name: string } | null;
  team_a: { name: string } | null;
  team_b: { name: string } | null;
};

export default function MatchesPage() {
  const [tournaments, setTournaments] = useState<Option[]>([]);
  const [teams, setTeams] = useState<Option[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [streams, setStreams] = useState<{ id: string; url: string }[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "scheduled" | "live" | "finished">("all");
  const [searchFilter, setSearchFilter] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "status">("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [tournamentId, setTournamentId] = useState("");
  const [teamAId, setTeamAId] = useState("");
  const [teamBId, setTeamBId] = useState("");
  const [format, setFormat] = useState("BO3");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Stream title detection ───────────────────────────────────────────
  const [detectUrl, setDetectUrl] = useState("");
  const [detectedTitle, setDetectedTitle] = useState<string | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<{ match: Match; score: number }[]>([]);

  function scoreMatch(title: string, m: Match) {
    const t = title.toLowerCase();
    let score = 0;
    if (m.team_a?.name && t.includes(m.team_a.name.toLowerCase())) score += 3;
    if (m.team_b?.name && t.includes(m.team_b.name.toLowerCase())) score += 3;
    if (m.tournament?.name) {
      const words = m.tournament.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      score += words.filter((w) => t.includes(w)).length;
    }
    return score;
  }

  async function detectStream() {
    setDetectLoading(true);
    setDetectError(null);
    setDetectedTitle(null);
    setSuggestions([]);

    const res = await fetch(`/api/youtube-title?url=${encodeURIComponent(detectUrl)}`);
    const data = await res.json();
    setDetectLoading(false);

    if (!res.ok) {
      setDetectError(data.error ?? "Could not detect video title");
      return;
    }

    setDetectedTitle(data.title);
    const ranked = matches
      .map((m) => ({ match: m, score: scoreMatch(data.title, m) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    setSuggestions(ranked);
  }

  async function assignStreamToMatch(matchId: string) {
    await updateMatch(matchId, { youtube_url: detectUrl });
    setDetectUrl("");
    setDetectedTitle(null);
    setSuggestions([]);
  }

  async function loadOptions() {
    const [{ data: t }, { data: tm }, { data: st }] = await Promise.all([
      supabase.from("tournaments").select("id, name").order("name"),
      supabase.from("teams").select("id, name").order("name"),
      supabase.from("streams").select("id, url").order("created_at", { ascending: false }),
    ]);
    setTournaments((t ?? []).map((r) => ({ id: r.id, label: r.name })));
    setTeams((tm ?? []).map((r) => ({ id: r.id, label: r.name })));
    setStreams(st ?? []);
  }

  async function loadMatches() {
    const { data, error } = await supabase
      .from("matches")
      .select(
        `id, scheduled_at, format, status, youtube_url, state, stream_id, auto_managed,
         tournament_id, team_a_id, team_b_id,
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

  async function updateMatch(
    id: string,
    fields: Partial<{
      status: string;
      youtube_url: string;
      stream_id: string | null;
      auto_managed: boolean;
      tournament_id: string;
      team_a_id: string;
      team_b_id: string;
      format: string;
      scheduled_at: string | null;
    }>
  ) {
    const { error } = await supabase.from("matches").update(fields).eq("id", id);
    if (error) setError(error.message);
    else loadMatches();
  }

  async function deleteMatch(id: string) {
    if (!confirm("Delete this match? This also deletes all its games, stats, picks/bans, objectives, and key moments.")) return;
    const { error } = await supabase.from("matches").delete().eq("id", id);
    if (error) setError(error.message);
    else loadMatches();
  }

  const filteredMatches = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    const filtered = matches.filter((m) => {
      if (statusFilter !== "all" && m.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [m.team_a?.name, m.team_b?.name, m.tournament?.name].join(" ").toLowerCase();
      return haystack.includes(q);
    });

    const statusOrder: Record<string, number> = { live: 0, scheduled: 1, finished: 2 };
    return [...filtered].sort((a, b) => {
      if (sortBy === "status") {
        return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
      }
      const aTime = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
      const bTime = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
      return sortBy === "newest" ? bTime - aTime : aTime - bTime;
    });
  }, [matches, statusFilter, searchFilter, sortBy]);

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
      prev.size === filteredMatches.length ? new Set() : new Set(filteredMatches.map((m) => m.id))
    );
  }

  async function bulkDeleteMatches() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected match(es)? This also deletes their games, stats, picks/bans, objectives, and key moments.`)) return;

    const { error } = await supabase.from("matches").delete().in("id", Array.from(selected));
    if (error) setError(error.message);
    setSelected(new Set());
    loadMatches();
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTournamentId, setEditTournamentId] = useState("");
  const [editTeamAId, setEditTeamAId] = useState("");
  const [editTeamBId, setEditTeamBId] = useState("");
  const [editFormat, setEditFormat] = useState("BO3");
  const [editScheduledAt, setEditScheduledAt] = useState("");

  function startEditMatch(m: Match) {
    setEditingId(m.id);
    setEditTournamentId(m.tournament_id ?? "");
    setEditTeamAId(m.team_a_id ?? "");
    setEditTeamBId(m.team_b_id ?? "");
    setEditFormat(m.format ?? "BO3");
    setEditScheduledAt(m.scheduled_at ? new Date(m.scheduled_at).toISOString().slice(0, 16) : "");
  }

  async function saveEditMatch(id: string) {
    await updateMatch(id, {
      tournament_id: editTournamentId,
      team_a_id: editTeamAId,
      team_b_id: editTeamBId,
      format: editFormat,
      scheduled_at: editScheduledAt ? new Date(editScheduledAt).toISOString() : null,
    });
    setEditingId(null);
  }

  return (
    <div className="text-white space-y-8 max-w-4xl">
      <div>
        <h1 className="text-lg font-bold mb-4">Detect match from stream URL</h1>
        <div className="flex gap-2 items-end max-w-xl">
          <input
            value={detectUrl}
            onChange={(e) => setDetectUrl(e.target.value)}
            placeholder="Paste a YouTube video URL"
            className="flex-1 bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
          <button
            onClick={detectStream}
            disabled={detectLoading || !detectUrl}
            className="bg-signal rounded px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {detectLoading ? "Checking..." : "Detect"}
          </button>
        </div>
        {detectError && <p className="text-sm text-red-400 mt-2">{detectError}</p>}
        {detectedTitle && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-white/50">
              Video title: <span className="text-white/80">&quot;{detectedTitle}&quot;</span>
            </p>
            {suggestions.length === 0 && (
              <p className="text-xs text-white/40">
                No matching scheduled matches found — the title may not mention team/tournament names, or the match hasn&apos;t been created yet.
              </p>
            )}
            {suggestions.map(({ match, score }) => (
              <div key={match.id} className="flex items-center justify-between border border-white/10 rounded px-3 py-2 text-sm">
                <span>
                  {match.team_a?.name} vs {match.team_b?.name}{" "}
                  <span className="text-white/40 text-xs">({match.tournament?.name} · match score {score})</span>
                </span>
                <button
                  onClick={() => assignStreamToMatch(match.id)}
                  className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10"
                >
                  Assign this stream
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-lg font-bold">All matches</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search team or tournament..."
              className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-xs w-56"
            />
            <div className="flex gap-1 text-xs">
              {(["all", "scheduled", "live", "finished"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-2 py-1 rounded uppercase ${
                    statusFilter === s ? "bg-signal" : "border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "newest" | "oldest" | "status")}
              className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="status">Sort by status</option>
            </select>
            {selected.size > 0 && (
              <button
                onClick={bulkDeleteMatches}
                className="text-xs border border-red-500/30 text-red-300 rounded px-3 py-1.5 hover:bg-red-500/10 whitespace-nowrap"
              >
                Delete {selected.size} selected
              </button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <input
            type="checkbox"
            checked={filteredMatches.length > 0 && selected.size === filteredMatches.length}
            onChange={toggleSelectAll}
          />
          Select all ({filteredMatches.length})
        </label>
        <div className="space-y-3">
          {filteredMatches.map((m) => (
            <div key={m.id} className="border border-white/10 rounded p-4 space-y-3">
              {editingId !== m.id && (
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  onChange={() => toggleSelected(m.id)}
                  className="mb-1"
                />
              )}
              {editingId === m.id ? (
                <div className="space-y-2 max-w-xl">
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={editTournamentId}
                      onChange={(e) => setEditTournamentId(e.target.value)}
                      className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Tournament</option>
                      {tournaments.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <select
                      value={editFormat}
                      onChange={(e) => setEditFormat(e.target.value)}
                      className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="BO1">BO1</option>
                      <option value="BO3">BO3</option>
                      <option value="BO5">BO5</option>
                    </select>
                    <select
                      value={editTeamAId}
                      onChange={(e) => setEditTeamAId(e.target.value)}
                      className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Team A</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <select
                      value={editTeamBId}
                      onChange={(e) => setEditTeamBId(e.target.value)}
                      className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Team B</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <input
                      type="datetime-local"
                      value={editScheduledAt}
                      onChange={(e) => setEditScheduledAt(e.target.value)}
                      className="col-span-2 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveEditMatch(m.id)} className="text-xs bg-signal rounded px-3 py-1.5">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      {m.team_a?.name ?? "TBD"} vs {m.team_b?.name ?? "TBD"}
                    </p>
                    <p className="text-xs text-white/50">
                      {m.tournament?.name} · {m.format} · {m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : "no time set"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
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
                    <button
                      onClick={() => startEditMatch(m)}
                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteMatch(m.id)}
                      className="text-xs border border-red-500/30 text-red-300 rounded px-2 py-1 hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
              <p className="text-[10px] text-white/30 uppercase tracking-wide">{m.state?.replace(/_/g, " ")}</p>

              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={m.stream_id ?? ""}
                  onChange={(e) => updateMatch(m.id, { stream_id: e.target.value || null })}
                  className="bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs max-w-[180px]"
                >
                  <option value="">No stream linked</option>
                  {streams.map((s) => (
                    <option key={s.id} value={s.id} title={s.url}>
                      {s.url.length > 28 ? s.url.slice(0, 28) + "…" : s.url}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-white/60">
                  <input
                    type="checkbox"
                    checked={m.auto_managed}
                    onChange={(e) => updateMatch(m.id, { auto_managed: e.target.checked })}
                  />
                  Auto-managed
                </label>
              </div>

              <div className="flex gap-2 items-center">
                <input
                  defaultValue={m.youtube_url ?? ""}
                  placeholder="YouTube livestream URL (manual console only)"
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
                <a
                  href={`/match/${m.id}`}
                  target="_blank"
                  className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10"
                >
                  View public page ↗
                </a>
              </div>
            </div>
          ))}
          {filteredMatches.length === 0 && <p className="text-white/30 text-sm">No matches match.</p>}
        </div>
      </div>
    </div>
  );
}
