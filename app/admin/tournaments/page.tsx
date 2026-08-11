"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TeamLogo, LOGO_BG_OVERRIDES, type LogoBgOverride } from "@/components/TeamLogo";

type Tournament = {
  id: string;
  name: string;
  tier: string;
  liquipedia_slug: string | null;
  date_display: string | null;
  start_date: string | null;
  end_date: string | null;
  logo_url: string | null;
  logo_bg_override: LogoBgOverride | null;
  fmvp_player_id: string | null;
  fmvp_player: { ign: string } | null;
  default_notification_tier: "normal" | "hot" | "priority";
  youtube_channel_url: string | null;
};

type Status = "ongoing" | "upcoming" | "completed";
type SortKey = "start_desc" | "start_asc" | "name";

// Same date-range logic as the public tournaments index — a tournament with
// both dates parsed is classified by today's date against that range;
// without dates (not yet parsed, or Liquipedia gave a TBD range) it's
// treated as upcoming since it can't be confirmed ongoing/finished yet.
function categorize(t: Tournament): Status {
  if (t.start_date && t.end_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (today < t.start_date) return "upcoming";
    if (today > t.end_date) return "completed";
    return "ongoing";
  }
  return "upcoming";
}

export default function TournamentsAdminPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [filter, setFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  // Only ongoing/upcoming tournaments are ever admin-relevant day to day —
  // completed ones have nothing left to edit. Tabbed the same way as
  // /admin/matches instead of always stacking every status section, and
  // "completed" is deliberately not one of the tabs (it's still reachable
  // via search if an old tournament needs a one-off fix).
  const [activeTab, setActiveTab] = useState<"ongoing" | "upcoming">("ongoing");
  const [sortKey, setSortKey] = useState<SortKey>("start_desc");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [name, setName] = useState("");
  const [tier, setTier] = useState("S");
  const [slug, setSlug] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [youtubeChannelUrl, setYoutubeChannelUrl] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTier, setEditTier] = useState("S");
  const [editSlug, setEditSlug] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editLogoUrl, setEditLogoUrl] = useState("");
  const [editLogoBgOverride, setEditLogoBgOverride] = useState<LogoBgOverride | "">("");
  const [editFmvpIgn, setEditFmvpIgn] = useState("");
  const [editYoutubeChannelUrl, setEditYoutubeChannelUrl] = useState("");
  const [allPlayerIgns, setAllPlayerIgns] = useState<string[]>([]);
  const [youtubeSyncStatus, setYoutubeSyncStatus] = useState<Record<string, string>>({});

  async function loadTournaments() {
    const { data } = await supabase
      .from("tournaments")
      .select(
        "id, name, tier, liquipedia_slug, date_display, start_date, end_date, logo_url, logo_bg_override, fmvp_player_id, fmvp_player:players(ign), default_notification_tier, youtube_channel_url"
      )
      .order("start_date", { ascending: false, nullsFirst: false });
    setTournaments((data as unknown as Tournament[]) ?? []);
  }

  // Fire-and-forget best-effort sync — a tournament save should never block
  // or fail on this. See app/api/admin/sync-tournament-youtube/route.ts for
  // what it actually does (no-ops cleanly if YOUTUBE_API_KEY isn't set).
  async function syncYoutubeStreams(tournamentId: string) {
    setYoutubeSyncStatus((prev) => ({ ...prev, [tournamentId]: "Checking YouTube channel..." }));
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/admin/sync-tournament-youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tournamentId }),
      });
      const data = await res.json();
      setYoutubeSyncStatus((prev) => ({ ...prev, [tournamentId]: data.message ?? data.error ?? "" }));
    } catch (err) {
      setYoutubeSyncStatus((prev) => ({ ...prev, [tournamentId]: (err as Error).message }));
    }
  }

  // Changing a tournament's default cascades to its matches — but only
  // future/in-progress ones (status != 'finished'); an already-finished
  // match's notification history shouldn't be reinterpreted retroactively,
  // and there's nothing left to notify about for it anyway.
  const [cascadingTierId, setCascadingTierId] = useState<string | null>(null);
  async function changeDefaultTier(id: string, tier: "normal" | "hot" | "priority") {
    setCascadingTierId(id);
    setTournaments((prev) => prev.map((t) => (t.id === id ? { ...t, default_notification_tier: tier } : t)));
    const { error: tError } = await supabase.from("tournaments").update({ default_notification_tier: tier }).eq("id", id);
    if (tError) {
      setError(tError.message);
      setCascadingTierId(null);
      return;
    }
    const { error: mError } = await supabase
      .from("matches")
      .update({ notification_tier: tier })
      .eq("tournament_id", id)
      .neq("status", "finished");
    if (mError) setError(mError.message);
    setCascadingTierId(null);
  }

  useEffect(() => {
    supabase.from("players").select("ign").order("ign").then(({ data }) => {
      setAllPlayerIgns((data ?? []).map((p) => p.ign));
    });
  }, []);

  useEffect(() => {
    loadTournaments();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = tournaments.filter((t) => {
      if (tierFilter && t.tier !== tierFilter) return false;
      if (categorize(t) !== activeTab) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || (t.liquipedia_slug ?? "").toLowerCase().includes(q);
    });
    return [...base].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      const aDate = a.start_date ?? "";
      const bDate = b.start_date ?? "";
      return sortKey === "start_asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
    });
  }, [tournaments, filter, tierFilter, activeTab, sortKey]);

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

    const { data: inserted, error } = await supabase
      .from("tournaments")
      .insert({
        name,
        tier,
        liquipedia_slug: slug || null,
        start_date: startDate || null,
        end_date: endDate || null,
        logo_url: logoUrl || null,
        youtube_channel_url: youtubeChannelUrl || null,
      })
      .select("id")
      .single();

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
    setYoutubeChannelUrl("");
    loadTournaments();
    if (inserted?.id && youtubeChannelUrl.trim()) syncYoutubeStreams(inserted.id);
  }

  function startEdit(t: Tournament) {
    setEditingId(t.id);
    setEditName(t.name);
    setEditTier(t.tier);
    setEditSlug(t.liquipedia_slug ?? "");
    setEditStartDate(t.start_date ?? "");
    setEditEndDate(t.end_date ?? "");
    setEditLogoUrl(t.logo_url ?? "");
    setEditLogoBgOverride(t.logo_bg_override ?? "");
    setEditFmvpIgn(t.fmvp_player?.ign ?? "");
    setEditYoutubeChannelUrl(t.youtube_channel_url ?? "");
  }

  async function setLogoBgOverride(id: string, value: LogoBgOverride | "") {
    const next = value || null;
    setTournaments((prev) => prev.map((t) => (t.id === id ? { ...t, logo_bg_override: next } : t)));
    const { error } = await supabase.from("tournaments").update({ logo_bg_override: next }).eq("id", id);
    if (error) setError(error.message);
  }

  async function saveEdit(id: string) {
    let fmvpPlayerId: string | null = null;
    if (editFmvpIgn.trim()) {
      const { data: player, error: lookupError } = await supabase
        .from("players")
        .select("id")
        .ilike("ign", editFmvpIgn.trim())
        .maybeSingle();
      if (lookupError) {
        setError(lookupError.message);
        return;
      }
      if (!player) {
        setError(`No player found with IGN "${editFmvpIgn.trim()}" — check spelling (must match exactly, case-insensitive).`);
        return;
      }
      fmvpPlayerId = player.id;
    }

    const previous = tournaments.find((t) => t.id === id);
    const newChannelUrl = editYoutubeChannelUrl.trim() || null;

    const { error } = await supabase
      .from("tournaments")
      .update({
        name: editName,
        tier: editTier,
        liquipedia_slug: editSlug || null,
        start_date: editStartDate || null,
        end_date: editEndDate || null,
        logo_url: editLogoUrl || null,
        logo_bg_override: editLogoBgOverride || null,
        fmvp_player_id: fmvpPlayerId,
        youtube_channel_url: newChannelUrl,
      })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadTournaments();
    // Only re-sync when the channel URL actually changed (set or edited) —
    // no point re-hitting the YouTube API's daily quota on every unrelated
    // field edit (dates, logo, etc.).
    if (newChannelUrl && newChannelUrl !== (previous?.youtube_channel_url ?? null)) syncYoutubeStreams(id);
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
    <div className="text-white space-y-6 max-w-6xl">
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
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Tier</label>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="S">S</option>
            <option value="A">A</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Liquipedia slug (optional)</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. MSC/2026 — leave blank for a custom/test tournament"
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
          <p className="text-[10px] text-white/30">
            Leave blank for a test match or any tournament that isn&apos;t on Liquipedia — it just won&apos;t auto-sync.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">End date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Logo URL</label>
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">YouTube channel URL (optional)</label>
          <input
            value={youtubeChannelUrl}
            onChange={(e) => setYoutubeChannelUrl(e.target.value)}
            placeholder="e.g. https://www.youtube.com/@channelname"
            className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm"
          />
          <p className="text-[10px] text-white/30">
            On save, this tournament&apos;s matches get auto-matched to this channel&apos;s public live/upcoming streams by
            date (needs YOUTUBE_API_KEY configured — see status after saving).
          </p>
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

      <div className="flex gap-1">
        {([
          { key: "ongoing", label: "🟢 Ongoing" },
          { key: "upcoming", label: "Upcoming" },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              setSelected(new Set());
            }}
            className={`text-sm px-4 py-2 rounded-t ${
              activeTab === tab.key ? "bg-white/10 text-white font-semibold" : "text-white/40 hover:text-white/70"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1 flex-wrap">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or slug..."
            className="flex-1 min-w-[160px] bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="">All tiers</option>
            <option value="S">S-Tier</option>
            <option value="A">A-Tier</option>
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
          >
            <option value="start_desc">Newest first</option>
            <option value="start_asc">Oldest first</option>
            <option value="name">Name A→Z</option>
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

      {filtered.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-white/40">
          <input
            type="checkbox"
            checked={selected.size === filtered.length}
            onChange={toggleSelectAll}
          />
          Select all ({filtered.length})
        </label>
      )}

      <section className="space-y-2">
            <table className="w-full text-sm">
              <thead className="text-white/40 text-left">
                <tr>
                  <th className="font-normal pb-2 w-8" />
                  <th className="font-normal pb-2 w-8">Logo</th>
                  <th className="font-normal pb-2 w-28">Logo backing</th>
                  <th className="font-normal pb-2">Name</th>
                  <th className="font-normal pb-2">Tier</th>
                  <th className="font-normal pb-2">Dates</th>
                  <th className="font-normal pb-2">Slug</th>
                  <th className="font-normal pb-2" title="Default notification tier for new matches — changing it also cascades to this tournament's future/in-progress matches (finished ones are left alone).">
                    Notifications
                  </th>
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
                          <TeamLogo url={editLogoUrl || null} alt={editName} bgOverride={editLogoBgOverride || null} size="sm" />
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={editLogoBgOverride}
                            onChange={(e) => setEditLogoBgOverride(e.target.value as LogoBgOverride | "")}
                            className="w-full bg-white/10 border border-white/10 rounded px-1.5 py-1 text-xs"
                          >
                            <option value="">Auto</option>
                            {LOGO_BG_OVERRIDES.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <select
                            value={editTier}
                            onChange={(e) => setEditTier(e.target.value)}
                            className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
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
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                          />
                          <input
                            type="date"
                            value={editEndDate}
                            onChange={(e) => setEditEndDate(e.target.value)}
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2 pr-2 space-y-1">
                          <input
                            value={editSlug}
                            onChange={(e) => setEditSlug(e.target.value)}
                            placeholder="Liquipedia slug (blank = custom/test)"
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                          />
                          <input
                            value={editFmvpIgn}
                            onChange={(e) => setEditFmvpIgn(e.target.value)}
                            placeholder="FMVP IGN (optional)"
                            list="all-player-igns"
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                          />
                          <datalist id="all-player-igns">
                            {allPlayerIgns.map((ign) => (
                              <option key={ign} value={ign} />
                            ))}
                          </datalist>
                          <input
                            value={editYoutubeChannelUrl}
                            onChange={(e) => setEditYoutubeChannelUrl(e.target.value)}
                            placeholder="YouTube channel URL (optional)"
                            className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="py-2" />
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
                        <td className="py-2">
                          <TeamLogo url={t.logo_url} alt={t.name} bgOverride={t.logo_bg_override} size="sm" />
                        </td>
                        <td className="py-2">
                          <select
                            value={t.logo_bg_override ?? ""}
                            onChange={(e) => setLogoBgOverride(t.id, e.target.value as LogoBgOverride | "")}
                            className="w-full bg-white/10 border border-white/10 rounded px-1.5 py-1 text-xs"
                          >
                            <option value="">Auto</option>
                            {LOGO_BG_OVERRIDES.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2">{t.name}</td>
                        <td className="py-2 text-white/60">{t.tier}-Tier</td>
                        <td className="py-2 text-white/60 text-xs">
                          {t.start_date ?? "?"} → {t.end_date ?? "?"}
                        </td>
                        <td className="py-2 text-white/40 text-xs">
                          {t.liquipedia_slug ?? "—"}
                          {t.fmvp_player?.ign && <div className="text-white/30">FMVP: {t.fmvp_player.ign}</div>}
                          {t.youtube_channel_url && (
                            <div className="text-white/30 flex items-center gap-1">
                              YT:{" "}
                              <button
                                onClick={() => syncYoutubeStreams(t.id)}
                                className="underline hover:text-white/60"
                                title="Re-check this channel's live/upcoming streams and fill any unlinked matches on the same date."
                              >
                                sync now
                              </button>
                            </div>
                          )}
                          {youtubeSyncStatus[t.id] && (
                            <div className="text-white/30 max-w-[180px]">{youtubeSyncStatus[t.id]}</div>
                          )}
                        </td>
                        <td className="py-2">
                          <select
                            value={t.default_notification_tier}
                            disabled={cascadingTierId === t.id}
                            onChange={(e) => changeDefaultTier(t.id, e.target.value as "normal" | "hot" | "priority")}
                            title="New matches for this tournament default to this tier. Changing it also updates every future/in-progress match already created here (finished matches are never touched)."
                            className={`text-xs rounded px-2 py-1 border disabled:opacity-40 ${
                              t.default_notification_tier === "hot"
                                ? "border-signal/50 text-signal bg-white/10"
                                : t.default_notification_tier === "priority"
                                ? "border-amber-400/50 text-amber-300 bg-white/10"
                                : "border-white/10 text-white/50 bg-white/10"
                            }`}
                          >
                            <option value="normal">🔕 Normal</option>
                            <option value="priority">🔔 Priority</option>
                            <option value="hot">🔥 Hot</option>
                          </select>
                        </td>
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
                    <td colSpan={9} className="py-4 text-white/30 text-center">
                      No tournaments match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
      </section>
    </div>
  );
}
