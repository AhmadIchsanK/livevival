"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Option = { id: string; label: string };

// A plain <select> forces picking from an existing (mostly Liquipedia-
// scraped) list of 150+ tournaments / 300+ teams, with no way to type a
// brand-new name — the only route to a custom/test match was leaving this
// page to create the tournament/team elsewhere first, with no visible
// pointer to do so. This adds a "+ Create new..." option that reveals an
// inline name field, inserts the row right here, and auto-selects it.
function CreatableSelect({
  label,
  options,
  value,
  onChange,
  onCreate,
  placeholder,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  onCreate: (name: string) => Promise<string | null>;
  placeholder: string;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitNew() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    const id = await onCreate(name);
    setBusy(false);
    if (id) {
      onChange(id);
      setCreating(false);
      setNewName("");
    }
  }

  if (creating) {
    return (
      <div className="space-y-1">
        <label className="text-xs text-white/50">{label}</label>
        <div className="flex gap-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitNew();
              }
            }}
            placeholder={`New ${label.toLowerCase()} name`}
            className="flex-1 bg-white/10 border border-signal/40 rounded px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={submitNew}
            disabled={busy || !newName.trim()}
            className="lv-btn-primary !px-3 !py-2 shrink-0"
          >
            {busy ? "..." : "Add"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            className="lv-btn-ghost !px-2 !py-2 shrink-0"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label className="text-xs text-white/50">{label}</label>
      <select
        required
        value={value}
        onChange={(e) => {
          if (e.target.value === "__new__") setCreating(true);
          else onChange(e.target.value);
        }}
        className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
      >
        <option value="">{placeholder}</option>
        <option value="__new__">+ Create new {label.toLowerCase()}…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
type Game = { id: string; game_number: number; vod_url: string | null; vod_url_source: "auto" | "manual" };
type Match = {
  id: string;
  scheduled_at: string | null;
  format: string | null;
  status: string;
  youtube_url: string | null;
  state: string;
  stream_id: string | null;
  update_source: "liquipedia" | "local_ocr";
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
  const [streams, setStreams] = useState<{ id: string; url: string; overlay_template: string }[]>([]);
  const [activeTab, setActiveTab] = useState<"scheduled" | "live" | "finished">("live");
  const [hasMoreFinished, setHasMoreFinished] = useState(false);
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

  // Minimal rows — a custom/test tournament or team created inline here has
  // no Liquipedia link and can be fully fleshed out later from
  // /admin/tournaments or /admin/teams (logo, dates, tier, etc.).
  async function createTournamentInline(name: string) {
    const { data, error } = await supabase
      .from("tournaments")
      .insert({ name, tier: "S" })
      .select("id")
      .single();
    if (error || !data) {
      setError(error?.message ?? "Failed to create tournament");
      return null;
    }
    setTournaments((prev) => [...prev, { id: data.id, label: name }].sort((a, b) => a.label.localeCompare(b.label)));
    return data.id;
  }

  async function createTeamInline(name: string) {
    const { data, error } = await supabase
      .from("teams")
      .insert({ name })
      .select("id")
      .single();
    if (error || !data) {
      setError(error?.message ?? "Failed to create team");
      return null;
    }
    setTeams((prev) => [...prev, { id: data.id, label: name }].sort((a, b) => a.label.localeCompare(b.label)));
    return data.id;
  }

  async function loadOptions() {
    const [{ data: t }, { data: tm }, { data: st }] = await Promise.all([
      supabase.from("tournaments").select("id, name").order("name"),
      supabase.from("teams").select("id, name").order("name"),
      supabase.from("streams").select("id, url, overlay_template").order("created_at", { ascending: false }),
    ]);
    setTournaments((t ?? []).map((r) => ({ id: r.id, label: r.name })));
    setTeams((tm ?? []).map((r) => ({ id: r.id, label: r.name })));
    setStreams(st ?? []);
  }

  const MATCHES_PAGE_SIZE = 30;

  async function loadMatches(tab: "scheduled" | "live" | "finished", offset = 0) {
    let query = supabase
      .from("matches")
      .select(
        `id, scheduled_at, format, status, youtube_url, state, stream_id, update_source,
         tournament_id, team_a_id, team_b_id,
         tournament:tournaments(name),
         team_a:teams!matches_team_a_id_fkey(name),
         team_b:teams!matches_team_b_id_fkey(name)`
      )
      .eq("status", tab);

    if (tab === "finished") {
      query = query.order("scheduled_at", { ascending: false }).range(offset, offset + MATCHES_PAGE_SIZE - 1);
    } else {
      query = query.order("scheduled_at", { ascending: true });
    }

    const { data, error } = await query;
    if (error) {
      setError(error.message);
      return;
    }
    if (tab === "finished" && offset > 0) {
      setMatches((prev) => [...prev, ...((data as unknown as Match[]) ?? [])]);
    } else {
      setMatches((data as unknown as Match[]) ?? []);
    }
    setHasMoreFinished((data?.length ?? 0) === MATCHES_PAGE_SIZE);
  }

  useEffect(() => {
    loadOptions();
  }, []);

  useEffect(() => {
    loadMatches(activeTab);
  }, [activeTab]);

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
    loadMatches(activeTab);
  }

  // Optimistic: patches local state immediately (and drops the row from
  // view if its new status no longer matches the active tab) instead of
  // waiting on a second network round-trip via loadMatches(). Previously
  // every field edit — including "Set live" — paid for an update *and* a
  // full re-fetch before anything visibly changed, and "Set live" while
  // viewing the Upcoming tab made the row vanish with no feedback while
  // that round-trip was in flight, which read as the toggle being stuck.
  async function updateMatch(
    id: string,
    fields: Partial<{
      status: string;
      youtube_url: string;
      stream_id: string | null;
      update_source: "liquipedia" | "local_ocr";
      tournament_id: string;
      team_a_id: string;
      team_b_id: string;
      format: string;
      scheduled_at: string | null;
    }>
  ) {
    const previous = matches;
    setMatches((prev) =>
      prev
        .map((m) => (m.id === id ? { ...m, ...fields } : m))
        .filter((m) => !("status" in fields) || m.id !== id || m.status === activeTab)
    );

    const { error } = await supabase.from("matches").update(fields).eq("id", id);
    if (error) {
      setError(error.message);
      setMatches(previous);
    }
  }

  async function deleteMatch(id: string) {
    if (!confirm("Delete this match? This also deletes all its games, stats, picks/bans, objectives, and key moments.")) return;
    const { error } = await supabase.from("matches").delete().eq("id", id);
    if (error) setError(error.message);
    else loadMatches(activeTab);
  }

  const filteredMatches = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    const filtered = matches.filter((m) => {
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
  }, [matches, searchFilter, sortBy]);

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
    loadMatches(activeTab);
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTournamentId, setEditTournamentId] = useState("");
  const [editTeamAId, setEditTeamAId] = useState("");
  const [editTeamBId, setEditTeamBId] = useState("");
  const [editFormat, setEditFormat] = useState("BO3");
  const [editScheduledAt, setEditScheduledAt] = useState("");

  // ── Per-game VOD editing (finished matches only) ─────────────────────
  const [expandedVodMatch, setExpandedVodMatch] = useState<string | null>(null);
  const [gamesByMatch, setGamesByMatch] = useState<Record<string, Game[]>>({});

  async function toggleVodEditor(matchId: string) {
    if (expandedVodMatch === matchId) {
      setExpandedVodMatch(null);
      return;
    }
    setExpandedVodMatch(matchId);
    if (!gamesByMatch[matchId]) {
      const { data } = await supabase
        .from("games")
        .select("id, game_number, vod_url, vod_url_source")
        .eq("match_id", matchId)
        .order("game_number");
      setGamesByMatch((prev) => ({ ...prev, [matchId]: (data as Game[]) ?? [] }));
    }
  }

  async function updateGameVod(matchId: string, gameId: string, fields: Partial<Pick<Game, "vod_url" | "vod_url_source">>) {
    setGamesByMatch((prev) => ({
      ...prev,
      [matchId]: (prev[matchId] ?? []).map((g) => (g.id === gameId ? { ...g, ...fields } : g)),
    }));
    const { error } = await supabase.from("games").update(fields).eq("id", gameId);
    if (error) setError(error.message);
  }

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
        <h1 className="lv-heading text-lg mb-4">Detect match from stream URL</h1>
        <div className="flex gap-2 items-end max-w-xl">
          <input
            value={detectUrl}
            onChange={(e) => setDetectUrl(e.target.value)}
            placeholder="Paste a YouTube video URL"
            className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
          <button
            onClick={detectStream}
            disabled={detectLoading || !detectUrl}
            className="lv-btn-primary !py-2"
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
                  className="lv-btn-ghost"
                >
                  Assign this stream
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h1 className="lv-heading text-lg mb-4">Create a match</h1>
        <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="col-span-2">
            <CreatableSelect
              label="Tournament"
              options={tournaments}
              value={tournamentId}
              onChange={setTournamentId}
              onCreate={createTournamentInline}
              placeholder="Select tournament"
            />
          </div>

          <CreatableSelect
            label="Team A"
            options={teams}
            value={teamAId}
            onChange={setTeamAId}
            onCreate={createTeamInline}
            placeholder="Select team"
          />

          <CreatableSelect
            label="Team B"
            options={teams}
            value={teamBId}
            onChange={setTeamBId}
            onCreate={createTeamInline}
            placeholder="Select team"
          />

          <div className="space-y-1">
            <label className="text-xs text-white/50">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
            >
              <option value="BO1">BO1</option>
              <option value="BO2">BO2</option>
              <option value="BO3">BO3</option>
              <option value="BO5">BO5</option>
              <option value="BO7">BO7</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Scheduled time</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="col-span-2 lv-btn-primary !py-2"
          >
            Create match
          </button>
        </form>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      </div>

      <div>
        <div className="flex gap-1 mb-4">
          {([
            { key: "live", label: "🔴 Ongoing" },
            { key: "scheduled", label: "Upcoming" },
            { key: "finished", label: "Finished" },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setSelected(new Set());
                // Upcoming matches read naturally soonest-first; everything
                // else (live/finished) reads naturally most-recent-first —
                // each tab lands on its own sensible default, still
                // overridable via the sort dropdown afterward.
                setSortBy(tab.key === "scheduled" ? "oldest" : "newest");
              }}
              className={`text-sm px-4 py-2 rounded-t ${
                activeTab === tab.key ? "bg-white/10 text-white font-semibold" : "text-white/40 hover:text-white/70"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="lv-heading text-lg">
            {activeTab === "live" ? "Ongoing matches" : activeTab === "scheduled" ? "Upcoming matches" : "Finished matches"}
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search team or tournament..."
              className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-xs w-56"
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "newest" | "oldest" | "status")}
              className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="status">Sort by status</option>
            </select>
            {selected.size > 0 && (
              <button
                onClick={bulkDeleteMatches}
                className="lv-btn-danger whitespace-nowrap"
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
                      className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Tournament</option>
                      {tournaments.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <select
                      value={editFormat}
                      onChange={(e) => setEditFormat(e.target.value)}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="BO1">BO1</option>
                      <option value="BO2">BO2</option>
                      <option value="BO3">BO3</option>
                      <option value="BO5">BO5</option>
                      <option value="BO7">BO7</option>
                    </select>
                    <select
                      value={editTeamAId}
                      onChange={(e) => setEditTeamAId(e.target.value)}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Team A</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    <select
                      value={editTeamBId}
                      onChange={(e) => setEditTeamBId(e.target.value)}
                      className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
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
                      className="col-span-2 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveEditMatch(m.id)} className="lv-btn-primary">
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="lv-btn-ghost"
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
                    <span className={m.status === "live" ? "lv-badge-live" : m.status === "finished" ? "lv-badge-finished" : "lv-badge-scheduled"}>
                      {m.status}
                    </span>
                    <button
                      onClick={() => startEditMatch(m)}
                      className="lv-btn-ghost !px-2 !py-1"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteMatch(m.id)}
                      className="lv-btn-danger !px-2 !py-1"
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
                  className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs max-w-[180px]"
                >
                  <option value="">No stream linked</option>
                  {streams.map((s) => {
                    // Real title once set (see admin/streams' own backfill/
                    // manual-edit pattern) — falls back to the raw URL for
                    // any stream that still has the "default" placeholder.
                    const label = s.overlay_template && s.overlay_template !== "default" ? s.overlay_template : s.url;
                    return (
                      <option key={s.id} value={s.id} title={s.url}>
                        {label.length > 28 ? label.slice(0, 28) + "…" : label}
                      </option>
                    );
                  })}
                </select>
                <select
                  value={m.update_source}
                  onChange={(e) => updateMatch(m.id, { update_source: e.target.value as "liquipedia" | "local_ocr" })}
                  title="Normal matches sync automatically from Liquipedia (score, picks/bans, VOD only). Hot matches are fully admin/OCR-controlled (adds KDA, items, moment log)."
                  className={`text-xs rounded px-2 py-1.5 border ${
                    m.update_source === "liquipedia"
                      ? "border-emerald-500/40 text-emerald-400 bg-white/10"
                      : "border-signal/50 text-signal bg-white/10"
                  }`}
                >
                  <option value="liquipedia">📡 Normal match</option>
                  <option value="local_ocr">🔥 Hot match</option>
                </select>
              </div>

              <div className="flex gap-2 items-center">
                <input
                  defaultValue={m.youtube_url ?? ""}
                  placeholder="YouTube livestream URL (manual console only)"
                  onBlur={(e) => updateMatch(m.id, { youtube_url: e.target.value })}
                  className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-1.5 text-xs"
                />
                {/* Strict color-coding so these three are never confused
                    for a routine "ghost" action mid-broadcast — amber for
                    the state that rolls a match back to not-yet-started,
                    win-green for the state that starts something, muted
                    slate for the one that ends it. Previously "Scheduled"
                    was only reachable from inside the live console. */}
                <button
                  onClick={() => updateMatch(m.id, { status: "scheduled" })}
                  disabled={m.status === "scheduled"}
                  className="lv-btn border border-amber-400/40 text-amber-300 hover:bg-amber-400/10 hover:border-amber-400/70 disabled:opacity-40"
                >
                  Set scheduled
                </button>
                <button
                  onClick={() => updateMatch(m.id, { status: "live" })}
                  disabled={!m.youtube_url}
                  title={m.youtube_url ? undefined : "Add a stream link first — a match can't go live without one"}
                  className="lv-btn border border-win/50 text-win hover:bg-win/10 hover:border-win disabled:opacity-40"
                >
                  Set live
                </button>
                <button
                  onClick={() => updateMatch(m.id, { status: "finished" })}
                  className="lv-btn border border-white/30 text-white/70 hover:bg-white/10 hover:border-white/50"
                >
                  Set finished
                </button>
                <a
                  href={`/admin/matches/${m.id}/live`}
                  className="lv-btn-primary"
                >
                  {m.status === "finished" ? "✏️ Edit match results" : "Open live console"}
                </a>
                <a
                  href={`/match/${m.id}`}
                  target="_blank"
                  className="lv-btn-ghost"
                >
                  View public page ↗
                </a>
                {m.status === "finished" && (
                  <button onClick={() => toggleVodEditor(m.id)} className="lv-btn-ghost">
                    {expandedVodMatch === m.id ? "Hide" : "Edit"} per-game VODs
                  </button>
                )}
              </div>

              {expandedVodMatch === m.id && (
                <div className="space-y-2 border-t border-white/10 pt-3">
                  {(gamesByMatch[m.id] ?? []).length === 0 && (
                    <p className="text-xs text-white/30">No games recorded yet for this match.</p>
                  )}
                  {(gamesByMatch[m.id] ?? []).map((g) => (
                    <div key={g.id} className="flex items-center gap-2">
                      <span className="text-xs text-white/50 w-14 shrink-0">Game {g.game_number}</span>
                      <input
                        defaultValue={g.vod_url ?? ""}
                        placeholder="VOD URL"
                        onBlur={(e) => {
                          if (e.target.value !== (g.vod_url ?? "")) {
                            updateGameVod(m.id, g.id, { vod_url: e.target.value || null, vod_url_source: "manual" });
                          }
                        }}
                        className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-1.5 text-xs"
                      />
                      <span
                        className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded ${
                          g.vod_url_source === "manual" ? "bg-signal/15 text-signal" : "bg-emerald-500/15 text-emerald-400"
                        }`}
                        title={
                          g.vod_url_source === "manual"
                            ? "Manually set — Liquipedia sync will not overwrite this"
                            : "Auto-synced from Liquipedia on every refresh"
                        }
                      >
                        {g.vod_url_source === "manual" ? "Manual" : "Auto"}
                      </span>
                      {g.vod_url_source === "manual" && (
                        <button
                          onClick={() => updateGameVod(m.id, g.id, { vod_url_source: "auto" })}
                          className="text-xs text-white/40 hover:text-white/70 whitespace-nowrap"
                          title="Let the next Liquipedia sync fill this back in"
                        >
                          Reset to auto
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {filteredMatches.length === 0 && <p className="text-white/30 text-sm">No matches match.</p>}
        </div>
        {activeTab === "finished" && hasMoreFinished && (
          <button
            onClick={() => loadMatches("finished", matches.length)}
            className="mt-3 text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5"
          >
            Load more finished matches
          </button>
        )}
      </div>
    </div>
  );
}
