"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TeamSocialLinks } from "@/components/TeamSocialLinks";
import { TeamLogo, LOGO_BG_OVERRIDES, type LogoBgOverride } from "@/components/TeamLogo";
import { loadRecentEdits, timeAgoShort, type RecentEdit } from "@/lib/recentEdits";

type Team = {
  id: string;
  name: string;
  logo_url: string | null;
  logo_bg_override: LogoBgOverride | null;
  location: string | null;
  region: string | null;
  website_url: string | null;
  twitter_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  youtube_url: string | null;
  discord_url: string | null;
};
type SortKey = "name" | "name_desc";

const TEAM_COLUMNS =
  "id, name, logo_url, logo_bg_override, location, region, website_url, twitter_url, instagram_url, facebook_url, youtube_url, discord_url";

type TeamFormState = {
  name: string;
  logoUrl: string;
  logoBgOverride: LogoBgOverride | "";
  location: string;
  region: string;
  websiteUrl: string;
  twitterUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  youtubeUrl: string;
  discordUrl: string;
};

const EMPTY_FORM: TeamFormState = {
  name: "",
  logoUrl: "",
  logoBgOverride: "",
  location: "",
  region: "",
  websiteUrl: "",
  twitterUrl: "",
  instagramUrl: "",
  facebookUrl: "",
  youtubeUrl: "",
  discordUrl: "",
};

function formToPayload(f: TeamFormState) {
  return {
    name: f.name,
    logo_url: f.logoUrl || null,
    logo_bg_override: f.logoBgOverride || null,
    location: f.location || null,
    region: f.region || null,
    website_url: f.websiteUrl || null,
    twitter_url: f.twitterUrl || null,
    instagram_url: f.instagramUrl || null,
    facebook_url: f.facebookUrl || null,
    youtube_url: f.youtubeUrl || null,
    discord_url: f.discordUrl || null,
  };
}

const URL_FIELDS: { key: keyof TeamFormState; label: string }[] = [
  { key: "websiteUrl", label: "Website" },
  { key: "twitterUrl", label: "X / Twitter" },
  { key: "instagramUrl", label: "Instagram" },
  { key: "facebookUrl", label: "Facebook" },
  { key: "youtubeUrl", label: "YouTube" },
  { key: "discordUrl", label: "Discord" },
];

// Nothing downstream (public team page, share cards) ever checked these
// were well-formed before saving — a typo'd URL just silently rendered a
// dead link later with no signal at save time. Returns a list of invalid
// field labels, empty when everything's fine or blank.
function invalidUrlFields(f: TeamFormState): string[] {
  const bad: string[] = [];
  for (const { key, label } of URL_FIELDS) {
    const value = (f[key] as string).trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") bad.push(label);
    } catch {
      bad.push(label);
    }
  }
  return bad;
}

// Loose near-duplicate check for the add-team form — strips spaces/case/
// common suffixes so "ONIC" vs "ONIC Esports" (different Liquipedia team-
// template titles for what's really the same org) surfaces as a warning
// before a duplicate gets created, instead of only being catchable after
// the fact via the merge tool.
function normalizeTeamName(name: string): string {
  return name.toLowerCase().replace(/\b(esports?|gaming|team|club)\b/g, "").replace(/[^a-z0-9]/g, "").trim();
}

function teamToForm(t: Team): TeamFormState {
  return {
    name: t.name,
    logoUrl: t.logo_url ?? "",
    logoBgOverride: t.logo_bg_override ?? "",
    location: t.location ?? "",
    region: t.region ?? "",
    websiteUrl: t.website_url ?? "",
    twitterUrl: t.twitter_url ?? "",
    instagramUrl: t.instagram_url ?? "",
    facebookUrl: t.facebook_url ?? "",
    youtubeUrl: t.youtube_url ?? "",
    discordUrl: t.discord_url ?? "",
  };
}

const TEAMS_PAGE_SIZE = 50;

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [hasMoreTeams, setHasMoreTeams] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [recentEdits, setRecentEdits] = useState<Record<string, RecentEdit>>({});
  const [form, setForm] = useState<TeamFormState>(EMPTY_FORM);
  const [showAddSocials, setShowAddSocials] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<TeamFormState>(EMPTY_FORM);

  const [mergeTargetId, setMergeTargetId] = useState("");
  const [merging, setMerging] = useState(false);

  function setFormField<K extends keyof TeamFormState>(key: K, value: TeamFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function setEditField<K extends keyof TeamFormState>(key: K, value: TeamFormState[K]) {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  }

  // Every admin list page except matches still fetched its whole table
  // unbounded on load — fine while teams/tournaments/streams are small, but
  // the same slowness matches hit as its list grew is just waiting to
  // happen here too. Paginated the same way: a bounded first page, "Load
  // more" for the rest. Search/filter below operates on whatever's loaded
  // so far, same tradeoff the matches page already accepts on its
  // paginated tabs.
  async function loadTeams(offset = 0) {
    if (offset > 0) setLoadingMore(true);
    const { data, error } = await supabase
      .from("teams")
      .select(TEAM_COLUMNS)
      .order("name", { ascending: true })
      .range(offset, offset + TEAMS_PAGE_SIZE - 1);
    setLoadingMore(false);
    if (error) {
      setError(error.message);
      return;
    }
    const page = (data as Team[]) ?? [];
    setTeams((prev) => (offset > 0 ? [...prev, ...page] : page));
    setHasMoreTeams(page.length === TEAMS_PAGE_SIZE);
  }

  useEffect(() => {
    loadTeams();
  }, []);

  useEffect(() => {
    loadRecentEdits("teams", teams.map((t) => t.id)).then(setRecentEdits);
  }, [teams]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = !q
      ? teams
      : teams.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.location ?? "").toLowerCase().includes(q) ||
            (t.region ?? "").toLowerCase().includes(q)
        );
    const sorted = [...base].sort((a, b) => a.name.localeCompare(b.name));
    return sortKey === "name_desc" ? sorted.reverse() : sorted;
  }, [teams, filter, sortKey]);

  const possibleDuplicates = useMemo(() => {
    const q = normalizeTeamName(form.name);
    if (q.length < 3) return [];
    return teams.filter((t) => {
      const n = normalizeTeamName(t.name);
      return n.length >= 3 && (n.includes(q) || q.includes(n));
    });
  }, [form.name, teams]);

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
    setError(null);

    const badUrls = invalidUrlFields(form);
    if (badUrls.length > 0) {
      setError(`Not a valid URL: ${badUrls.join(", ")}`);
      return;
    }

    setLoading(true);

    const { error } = await supabase.from("teams").insert(formToPayload(form));

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setForm(EMPTY_FORM);
    setShowAddSocials(false);
    loadTeams();
  }

  function startEdit(t: Team) {
    setEditingId(t.id);
    setEditForm(teamToForm(t));
  }

  async function setLogoBgOverride(id: string, value: LogoBgOverride | "") {
    const next = value || null;
    setTeams((prev) => prev.map((t) => (t.id === id ? { ...t, logo_bg_override: next } : t)));
    const { error } = await supabase.from("teams").update({ logo_bg_override: next }).eq("id", id);
    if (error) setError(error.message);
  }

  async function saveEdit(id: string) {
    const badUrls = invalidUrlFields(editForm);
    if (badUrls.length > 0) {
      setError(`Not a valid URL: ${badUrls.join(", ")}`);
      return;
    }
    const { error } = await supabase.from("teams").update(formToPayload(editForm)).eq("id", id);
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

  const socialInputClass =
    "w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs outline-none focus:border-signal";

  return (
    <div className="text-white space-y-6 max-w-5xl">
      <h1 className="lv-heading text-lg">Teams</h1>

      <form onSubmit={handleAdd} className="space-y-3">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[160px] space-y-1">
            <label className="text-xs text-white/50">Team name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setFormField("name", e.target.value)}
              placeholder="e.g. RRQ Hoshi"
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
            />
            {possibleDuplicates.length > 0 && (
              <p className="text-[10px] text-amber-300">
                Possibly already exists: {possibleDuplicates.map((t) => t.name).join(", ")} — use Merge below instead of creating a duplicate.
              </p>
            )}
          </div>
          <div className="w-40 space-y-1">
            <label className="text-xs text-white/50">Location</label>
            <input
              value={form.location}
              onChange={(e) => setFormField("location", e.target.value)}
              placeholder="Jakarta, Indonesia"
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
            />
          </div>
          <div className="w-32 space-y-1">
            <label className="text-xs text-white/50">Region</label>
            <input
              value={form.region}
              onChange={(e) => setFormField("region", e.target.value)}
              placeholder="Indonesia"
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
            />
          </div>
          <div className="flex-1 min-w-[200px] space-y-1">
            <label className="text-xs text-white/50">Logo URL</label>
            <input
              value={form.logoUrl}
              onChange={(e) => setFormField("logoUrl", e.target.value)}
              placeholder="https://..."
              className="w-full bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
            />
          </div>
          <button type="submit" disabled={loading} className="lv-btn-primary !py-2">
            Add
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowAddSocials((v) => !v)}
          className="text-xs text-white/40 hover:text-white/70"
        >
          {showAddSocials ? "− Hide" : "+ Add"} website / social links
        </button>
        {showAddSocials && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <input
              value={form.websiteUrl}
              onChange={(e) => setFormField("websiteUrl", e.target.value)}
              placeholder="Website URL"
              className={socialInputClass}
            />
            <input
              value={form.twitterUrl}
              onChange={(e) => setFormField("twitterUrl", e.target.value)}
              placeholder="X / Twitter URL"
              className={socialInputClass}
            />
            <input
              value={form.instagramUrl}
              onChange={(e) => setFormField("instagramUrl", e.target.value)}
              placeholder="Instagram URL"
              className={socialInputClass}
            />
            <input
              value={form.facebookUrl}
              onChange={(e) => setFormField("facebookUrl", e.target.value)}
              placeholder="Facebook URL"
              className={socialInputClass}
            />
            <input
              value={form.youtubeUrl}
              onChange={(e) => setFormField("youtubeUrl", e.target.value)}
              placeholder="YouTube URL"
              className={socialInputClass}
            />
            <input
              value={form.discordUrl}
              onChange={(e) => setFormField("discordUrl", e.target.value)}
              placeholder="Discord URL"
              className={socialInputClass}
            />
          </div>
        )}
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 flex-1 min-w-[200px]">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, location, or region..."
            className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
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
              className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
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
            <th className="font-normal pb-2 w-28">Logo backing</th>
            <th className="font-normal pb-2">Name</th>
            <th className="font-normal pb-2">Location / Region</th>
            <th className="font-normal pb-2">Links</th>
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
                    <TeamLogo url={editForm.logoUrl || null} alt={editForm.name} bgOverride={editForm.logoBgOverride || null} size="sm" />
                  </td>
                  <td className="py-2 pr-2 align-top">
                    <select
                      value={editForm.logoBgOverride}
                      onChange={(e) => setEditField("logoBgOverride", e.target.value as LogoBgOverride | "")}
                      className="w-full bg-white/10 border border-white/10 rounded px-1.5 py-1 text-xs"
                    >
                      <option value="">Auto</option>
                      {LOGO_BG_OVERRIDES.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-2 align-top space-y-1 min-w-[160px]">
                    <input
                      value={editForm.name}
                      onChange={(e) => setEditField("name", e.target.value)}
                      placeholder="Team name"
                      className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                    <input
                      value={editForm.logoUrl}
                      onChange={(e) => setEditField("logoUrl", e.target.value)}
                      placeholder="Logo URL"
                      className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="py-2 pr-2 align-top space-y-1 min-w-[140px]">
                    <input
                      value={editForm.location}
                      onChange={(e) => setEditField("location", e.target.value)}
                      placeholder="Location"
                      className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                    <input
                      value={editForm.region}
                      onChange={(e) => setEditField("region", e.target.value)}
                      placeholder="Region"
                      className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="py-2 pr-2 align-top min-w-[220px]">
                    <div className="grid grid-cols-2 gap-1">
                      <input
                        value={editForm.websiteUrl}
                        onChange={(e) => setEditField("websiteUrl", e.target.value)}
                        placeholder="Website"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={editForm.twitterUrl}
                        onChange={(e) => setEditField("twitterUrl", e.target.value)}
                        placeholder="X / Twitter"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={editForm.instagramUrl}
                        onChange={(e) => setEditField("instagramUrl", e.target.value)}
                        placeholder="Instagram"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={editForm.facebookUrl}
                        onChange={(e) => setEditField("facebookUrl", e.target.value)}
                        placeholder="Facebook"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={editForm.youtubeUrl}
                        onChange={(e) => setEditField("youtubeUrl", e.target.value)}
                        placeholder="YouTube"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                      <input
                        value={editForm.discordUrl}
                        onChange={(e) => setEditField("discordUrl", e.target.value)}
                        placeholder="Discord"
                        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                    </div>
                  </td>
                  <td className="py-2 text-right space-x-2 align-top">
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
                  <td className="py-2 text-white/60">
                    {[t.location, t.region].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="py-2">
                    <TeamSocialLinks team={t} />
                  </td>
                  <td className="py-2 text-right">
                    <div className="space-x-2">
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
                    </div>
                    {recentEdits[t.id] && (
                      <div className="text-[10px] text-white/30 mt-1">
                        Edited {timeAgoShort(recentEdits[t.id].changedAt)} by {recentEdits[t.id].actorLabel}
                      </div>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={7} className="py-4 text-white/30 text-center">No teams match.</td></tr>
          )}
        </tbody>
      </table>
      {hasMoreTeams && (
        <button
          onClick={() => loadTeams(teams.length)}
          disabled={loadingMore}
          className="text-xs text-white/50 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more teams"}
        </button>
      )}
    </div>
  );
}
