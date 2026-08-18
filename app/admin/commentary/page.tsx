"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useLanguage } from "@/lib/i18n";
import {
  COMMENTARY_CONDITIONS,
  COMMENTARY_PLACEHOLDERS,
  renderTemplate,
  type CommentaryCondition,
} from "@/lib/matchCommentary";

type Row = {
  id: string;
  condition: CommentaryCondition;
  template: string;
  template_id: string | null;
  enabled: boolean;
  updated_at: string;
  use_count: number;
  last_used_at: string | null;
};

type Suggestion = { condition: CommentaryCondition; template: string; templateId: string; reads: string; readsId: string };

// Hard cap on how many custom lines the library holds. Built-in lines ship in
// code on top of this; 300 editable rows is plenty of variety without letting
// the table grow unbounded (and keeps the AI auto-improve tool from over-adding).
const MAX_TEMPLATES = 300;

// Sample facts per condition so the editor can show a live preview of a
// template as it would read on the Moment list.
const PREVIEW_FACTS: Record<CommentaryCondition, Record<string, string | number>> = {
  net_worth: { lead: "ONIC", trail: "FLCN", diff: "14.0k", closed: "6.0k" },
  kills: { lead: "ONIC", trail: "FLCN", hi: 10, lo: 4, count: 3, scorer: "ONIC" },
  tower: { team: "ONIC", count: 5, leader: "ONIC", hi: 7, lo: 2 },
  turtle: { team: "ONIC" },
  lord: { team: "ONIC" },
  player_kda: { player: "Kairi", hero: "Ling", k: 8, d: 0, a: 3, ka: 11 },
  win_prob: { favored: "ONIC", pct: 90, to: "ONIC" },
  hero: { player: "Kairi", hero: "Ling" },
  general: {},
};

const CONDITION_LABEL: Record<string, string> = Object.fromEntries(COMMENTARY_CONDITIONS.map((c) => [c.key, c.label]));

export default function CommentaryTemplatesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [conditionFilter, setConditionFilter] = useState<string>("");

  const [newCondition, setNewCondition] = useState<CommentaryCondition>("net_worth");
  const [newTemplate, setNewTemplate] = useState("");
  const [newTemplateId, setNewTemplateId] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState("");
  const [editTemplateId, setEditTemplateId] = useState("");
  const [editCondition, setEditCondition] = useState<CommentaryCondition>("net_worth");

  // AI auto-improve panel
  const [aiCondition, setAiCondition] = useState<string>("all");
  const [aiCount, setAiCount] = useState<number>(8);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  async function generateSuggestions() {
    setAiLoading(true);
    setAiError(null);
    setSuggestions([]);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch("/api/admin/commentary-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ condition: aiCondition, count: aiCount }),
      });
      const json = await res.json();
      if (!res.ok) {
        setAiError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setSuggestions(json.suggestions ?? []);
      if ((json.suggestions ?? []).length === 0) setAiError("The model returned no new lines — try again.");
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiLoading(false);
    }
  }

  async function acceptSuggestion(s: Suggestion) {
    if (rows.length >= MAX_TEMPLATES) {
      setAiError(`Template limit reached (${MAX_TEMPLATES}). Delete some lines before adding more.`);
      return;
    }
    const { error } = await supabase.from("commentary_templates").insert({ condition: s.condition, template: s.template, template_id: s.templateId || null });
    if (error) {
      setAiError(error.message);
      return;
    }
    setSuggestions((prev) => prev.filter((x) => !(x.condition === s.condition && x.template === s.template)));
    load();
  }

  async function acceptAllSuggestions() {
    if (suggestions.length === 0) return;
    const room = MAX_TEMPLATES - rows.length;
    if (room <= 0) {
      setAiError(`Template limit reached (${MAX_TEMPLATES}). Delete some lines before adding more.`);
      return;
    }
    const toAdd = suggestions.slice(0, room);
    const { error } = await supabase
      .from("commentary_templates")
      .insert(toAdd.map((s) => ({ condition: s.condition, template: s.template, template_id: s.templateId || null })));
    if (error) {
      setAiError(error.message);
      return;
    }
    if (toAdd.length < suggestions.length) {
      setAiError(`Added ${toAdd.length}; stopped at the ${MAX_TEMPLATES}-line cap. Prune least-used lines to make room for the rest.`);
      setSuggestions((prev) => prev.slice(toAdd.length));
    } else {
      setSuggestions([]);
    }
    load();
  }

  async function load() {
    const { data, error } = await supabase
      .from("commentary_templates")
      .select("id, condition, template, template_id, enabled, updated_at, use_count, last_used_at")
      .order("condition", { ascending: true })
      .order("updated_at", { ascending: false });
    if (error) setError(error.message);
    setRows((data as Row[]) ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(
    () => (conditionFilter ? rows.filter((r) => r.condition === conditionFilter) : rows),
    [rows, conditionFilter]
  );

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!newTemplate.trim()) return;
    if (rows.length >= MAX_TEMPLATES) {
      setError(`Template limit reached (${MAX_TEMPLATES}). Delete some lines — e.g. the least-used — before adding more.`);
      return;
    }
    setLoading(true);
    setError(null);
    const { error } = await supabase
      .from("commentary_templates")
      .insert({ condition: newCondition, template: newTemplate.trim(), template_id: newTemplateId.trim() || null });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNewTemplate("");
    setNewTemplateId("");
    load();
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("commentary_templates")
      .update({ condition: editCondition, template: editTemplate.trim(), template_id: editTemplateId.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    load();
  }

  async function toggle(r: Row) {
    const { error } = await supabase.from("commentary_templates").update({ enabled: !r.enabled }).eq("id", r.id);
    if (error) setError(error.message);
    else load();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this commentary line?")) return;
    const { error } = await supabase.from("commentary_templates").delete().eq("id", id);
    if (error) setError(error.message);
    else load();
  }

  // Batch-prune the lines that fire least often. Ranks by use_count (then oldest
  // last_used) and deletes the lowest N, after an explicit confirm — keeps the
  // library lean and varied without hunting one dud line at a time.
  async function deleteLeastUsed() {
    if (rows.length === 0) return;
    const answer = window.prompt(
      `How many of the LEAST-used lines should be deleted? (1–${rows.length})\n\nLines are ranked by how often they've actually fired; ties broken by oldest last-used.`,
      "20"
    );
    if (answer == null) return;
    const n = Math.min(rows.length, Math.max(1, Math.floor(Number(answer)) || 0));
    if (!n) return;
    const ranked = [...rows].sort((a, b) => {
      if (a.use_count !== b.use_count) return a.use_count - b.use_count;
      const at = a.last_used_at ? Date.parse(a.last_used_at) : 0;
      const bt = b.last_used_at ? Date.parse(b.last_used_at) : 0;
      return at - bt;
    });
    const victims = ranked.slice(0, n);
    const preview = victims.slice(0, 8).map((r) => `• (${r.use_count}×) ${r.template}`).join("\n");
    if (
      !window.confirm(
        `Delete these ${victims.length} least-used line${victims.length === 1 ? "" : "s"}? This cannot be undone.\n\n${preview}${
          victims.length > 8 ? `\n…and ${victims.length - 8} more` : ""
        }`
      )
    )
      return;
    const { error } = await supabase.from("commentary_templates").delete().in("id", victims.map((v) => v.id));
    if (error) setError(error.message);
    else load();
  }

  const activeCondition: CommentaryCondition = editingId ? editCondition : newCondition;
  const activeTemplate = editingId ? editTemplate : newTemplate;
  const preview = renderTemplate(activeTemplate || "", PREVIEW_FACTS[activeCondition]);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Auto-commentary Templates</h1>
        <p className="text-sm text-white/50 mt-1">
          Caster-style lines the live Moment list posts automatically (every 1–2 minutes) when a game condition fires.
          These are added to the built-in lines that ship in code — edit here with no deploy. Toggle which condition
          categories are active per match in the Hot Match live console.
        </p>
      </div>

      {error && <div className="lv-alert-warning text-sm px-3 py-2">{error}</div>}

      {/* Add / edit form */}
      <form onSubmit={add} className="space-y-3 border border-white/10 rounded-lg p-4 bg-white/5">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">
            <span className="block text-white/50 text-xs mb-1">Condition</span>
            <select
              value={newCondition}
              onChange={(e) => setNewCondition(e.target.value as CommentaryCondition)}
              className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
            >
              {COMMENTARY_CONDITIONS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex-1 min-w-[220px]">
            <span className="block text-white/50 text-xs mb-1">🇬🇧 English (use the placeholders below)</span>
            <input
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
              placeholder="e.g. {lead} making it look easy, {diff} clear."
              className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex-1 min-w-[220px]">
            <span className="block text-white/50 text-xs mb-1">🇮🇩 Bahasa Indonesia (opsional — SAME placeholders)</span>
            <input
              value={newTemplateId}
              onChange={(e) => setNewTemplateId(e.target.value)}
              placeholder="cth. {lead} santai aja, unggul {diff}."
              className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <button type="submit" disabled={loading || !newTemplate.trim()} className="lv-btn-primary text-sm disabled:opacity-40">
            Add line
          </button>
        </div>

        {/* Placeholder help + live preview for whatever's being authored */}
        <div className="text-xs text-white/50 space-y-1">
          <div className="flex flex-wrap gap-2">
            {COMMENTARY_PLACEHOLDERS[activeCondition].length === 0 ? (
              <span className="text-white/30">No placeholders for this condition — write a plain line.</span>
            ) : (
              COMMENTARY_PLACEHOLDERS[activeCondition].map((p) => (
                <span key={p.token} className="inline-flex items-center gap-1 bg-black/30 border border-white/10 rounded px-1.5 py-0.5">
                  <code className="text-signal">{p.token}</code>
                  <span className="text-white/40">{p.desc}</span>
                </span>
              ))
            )}
          </div>
          {activeTemplate.trim() && (
            <div>
              Preview:{" "}
              {preview ? (
                <span className="text-white/80">&ldquo;{preview}&rdquo;</span>
              ) : (
                <span className="text-amber-300">uses a placeholder this condition doesn&apos;t provide — it won&apos;t fire.</span>
              )}
            </div>
          )}
        </div>
      </form>

      {/* AI auto-improve */}
      <div className="border border-signal/25 rounded-lg p-4 bg-signal/5 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <span>✨ AI auto-improve</span>
            </h2>
            <p className="text-xs text-white/50 mt-1 max-w-xl">
              Generate fresh, varied caster lines with AI. Every suggestion is validated to use only the placeholders its
              condition supplies, and de-duplicated against what you already have. Review below and add the ones you like.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs">
              <span className="block text-white/50 mb-1">Condition</span>
              <select
                value={aiCondition}
                onChange={(e) => setAiCondition(e.target.value)}
                className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
              >
                <option value="all">All conditions</option>
                {COMMENTARY_CONDITIONS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-white/50 mb-1">Per condition</span>
              <input
                type="number"
                min={3}
                max={12}
                value={aiCount}
                onChange={(e) => setAiCount(Math.min(12, Math.max(3, Number(e.target.value) || 8)))}
                className="w-16 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
              />
            </label>
            <button onClick={generateSuggestions} disabled={aiLoading} className="lv-btn-primary text-sm disabled:opacity-40">
              {aiLoading ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>

        {aiError && <div className="lv-alert-warning text-xs px-3 py-2">{aiError}</div>}

        {suggestions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">{suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}</span>
              <div className="flex gap-2">
                <button onClick={acceptAllSuggestions} className="lv-btn-primary text-xs">
                  Add all
                </button>
                <button onClick={() => setSuggestions([])} className="lv-btn-ghost text-xs">
                  Dismiss all
                </button>
              </div>
            </div>
            <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
              {suggestions.map((s, i) => (
                <div key={`${s.condition}-${i}`} className="flex items-start gap-3 border border-white/10 rounded p-2 bg-black/20">
                  <div className="flex-1 min-w-0">
                    <span className="text-[10px] uppercase tracking-wide text-signal/80 bg-signal/10 border border-signal/20 rounded px-1.5 py-0.5">
                      {CONDITION_LABEL[s.condition] ?? s.condition}
                    </span>
                    <p className="text-sm text-white/85 mt-1"><span className="text-white/30 mr-1">🇬🇧</span>{s.template}</p>
                    {s.templateId && <p className="text-sm text-white/70 mt-0.5"><span className="text-white/30 mr-1">🇮🇩</span>{s.templateId}</p>}
                    <p className="text-[11px] text-white/30 mt-0.5">Reads: &ldquo;{s.reads}&rdquo;{s.readsId && ` · ${s.readsId}`}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => acceptSuggestion(s)}
                      className="text-[11px] border border-white/15 text-emerald-300 rounded px-2 py-1 hover:bg-emerald-500/10"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => setSuggestions((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-[11px] border border-white/15 rounded px-2 py-1 hover:bg-white/10"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Filter + library controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-white/40">Filter:</span>
        <select
          value={conditionFilter}
          onChange={(e) => setConditionFilter(e.target.value)}
          className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
        >
          <option value="">All conditions</option>
          {COMMENTARY_CONDITIONS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-white/30">{filtered.length} line{filtered.length === 1 ? "" : "s"}</span>
        <span className={`text-xs ${rows.length >= MAX_TEMPLATES ? "text-amber-300" : "text-white/30"}`}>
          · {rows.length}/{MAX_TEMPLATES} stored
        </span>
        <button
          onClick={deleteLeastUsed}
          disabled={rows.length === 0}
          title="Bulk-delete the lines that fire least often (ranked by usage), after a confirm"
          className="text-xs border border-white/15 text-red-300 rounded px-2 py-1 hover:bg-red-500/10 disabled:opacity-40 ml-auto"
        >
          🧹 Delete least-used…
        </button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {filtered.length === 0 && <p className="text-sm text-white/40">No custom lines yet — add one above.</p>}
        {filtered.map((r) => (
          <div key={r.id} className="border border-white/10 rounded-lg p-3 bg-white/5">
            {editingId === r.id ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2 items-center">
                  <select
                    value={editCondition}
                    onChange={(e) => setEditCondition(e.target.value as CommentaryCondition)}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                  >
                    {COMMENTARY_CONDITIONS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="block text-[11px] text-white/40">🇬🇧 English</label>
                <textarea
                  value={editTemplate}
                  onChange={(e) => setEditTemplate(e.target.value)}
                  rows={2}
                  className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
                />
                <label className="block text-[11px] text-white/40">🇮🇩 Bahasa Indonesia (opsional)</label>
                <textarea
                  value={editTemplateId}
                  onChange={(e) => setEditTemplateId(e.target.value)}
                  rows={2}
                  placeholder="Kosongin buat pakai versi Inggris."
                  className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
                />
                <div className="flex gap-2">
                  <button onClick={() => saveEdit(r.id)} className="lv-btn-primary text-xs">
                    Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="lv-btn-ghost text-xs">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wide text-signal/80 bg-signal/10 border border-signal/20 rounded px-1.5 py-0.5">
                      {CONDITION_LABEL[r.condition] ?? r.condition}
                    </span>
                    {!r.enabled && <span className="text-[10px] text-white/40 border border-white/15 rounded px-1.5 py-0.5">muted</span>}
                    <span
                      className={`text-[10px] border rounded px-1.5 py-0.5 ${r.use_count > 0 ? "text-white/50 border-white/15" : "text-white/30 border-white/10"}`}
                      title={r.last_used_at ? `Last fired ${new Date(r.last_used_at).toLocaleString()}` : "Hasn't fired yet"}
                    >
                      {r.use_count}× used
                    </span>
                  </div>
                  <p className={`text-sm mt-1 ${r.enabled ? "text-white/85" : "text-white/40 line-through"}`}>
                    <span className="text-white/30 mr-1">🇬🇧</span>{r.template}
                  </p>
                  {r.template_id ? (
                    <p className={`text-sm mt-0.5 ${r.enabled ? "text-white/70" : "text-white/40 line-through"}`}>
                      <span className="text-white/30 mr-1">🇮🇩</span>{r.template_id}
                    </p>
                  ) : (
                    <p className="text-[11px] text-amber-300/70 mt-0.5">🇮🇩 no Indonesian version — shows English in ID mode</p>
                  )}
                  <p className="text-[11px] text-white/30 mt-0.5">
                    Reads: &ldquo;{renderTemplate(r.template, PREVIEW_FACTS[r.condition]) ?? "— (placeholder mismatch)"}&rdquo;
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => toggle(r)} className="text-[11px] border border-white/15 rounded px-2 py-1 hover:bg-white/10">
                    {r.enabled ? "Mute" : "Enable"}
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(r.id);
                      setEditTemplate(r.template);
                      setEditTemplateId(r.template_id ?? "");
                      setEditCondition(r.condition);
                    }}
                    className="text-[11px] border border-white/15 rounded px-2 py-1 hover:bg-white/10"
                  >
                    Edit
                  </button>
                  <button onClick={() => remove(r.id)} className="text-[11px] border border-white/15 text-red-300 rounded px-2 py-1 hover:bg-red-500/10">
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
