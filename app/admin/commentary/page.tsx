"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
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
  enabled: boolean;
  updated_at: string;
};

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTemplate, setEditTemplate] = useState("");
  const [editCondition, setEditCondition] = useState<CommentaryCondition>("net_worth");

  // AI auto-improve panel
  const [aiCondition, setAiCondition] = useState<string>("all");
  const [aiCount, setAiCount] = useState<number>(8);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ condition: CommentaryCondition; template: string; reads: string }[]>([]);

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

  async function acceptSuggestion(s: { condition: CommentaryCondition; template: string }) {
    const { error } = await supabase.from("commentary_templates").insert({ condition: s.condition, template: s.template });
    if (error) {
      setAiError(error.message);
      return;
    }
    setSuggestions((prev) => prev.filter((x) => !(x.condition === s.condition && x.template === s.template)));
    load();
  }

  async function acceptAllSuggestions() {
    if (suggestions.length === 0) return;
    const { error } = await supabase
      .from("commentary_templates")
      .insert(suggestions.map((s) => ({ condition: s.condition, template: s.template })));
    if (error) {
      setAiError(error.message);
      return;
    }
    setSuggestions([]);
    load();
  }

  async function load() {
    const { data, error } = await supabase
      .from("commentary_templates")
      .select("id, condition, template, enabled, updated_at")
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
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("commentary_templates").insert({ condition: newCondition, template: newTemplate.trim() });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setNewTemplate("");
    load();
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("commentary_templates")
      .update({ condition: editCondition, template: editTemplate.trim(), updated_at: new Date().toISOString() })
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
          <div className="flex-1 min-w-[260px]">
            <span className="block text-white/50 text-xs mb-1">Line (use the placeholders below)</span>
            <input
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
              placeholder="e.g. {lead} making it look easy, {diff} clear."
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
                    <p className="text-sm text-white/85 mt-1">{s.template}</p>
                    <p className="text-[11px] text-white/30 mt-0.5">Reads: &ldquo;{s.reads}&rdquo;</p>
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

      {/* Filter */}
      <div className="flex items-center gap-2">
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
                <textarea
                  value={editTemplate}
                  onChange={(e) => setEditTemplate(e.target.value)}
                  rows={2}
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
                  </div>
                  <p className={`text-sm mt-1 ${r.enabled ? "text-white/85" : "text-white/40 line-through"}`}>{r.template}</p>
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
