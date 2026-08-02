"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Template = {
  id: string;
  type: string;
  label_template: string;
  phase: string | null;
  sort_order: number;
  telegram_enabled: boolean;
  telegram_message_template: string | null;
};

// Matches key_moments_type_check in the DB, plus "phase_notice" — a
// config-only type that never shows up in the live console's moment
// picker (see the phaseFilter/TYPES split below), used purely to hold a
// Telegram toggle + message template for a phase transition (e.g. "Draft
// started") that isn't itself a loggable moment.
const TYPES = [
  "savage", "maniac", "lord_steal", "turtle_steal", "ace",
  "phase_change", "game_finish", "match_finish", "game_pause", "pick", "ban", "custom", "phase_notice",
];

// Matches match_state (superset of game_state) — "Any" (null) applies the
// template regardless of the match's/game's current phase.
const PHASES = [
  "MATCH_NOT_STARTED", "DRAFT_STARTED", "DRAFT_COMPLETE", "GAME_STARTED",
  "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE", "CUSTOM", "STREAM_ENDED",
];

export default function MomentTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [phaseFilter, setPhaseFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [type, setType] = useState("custom");
  const [labelTemplate, setLabelTemplate] = useState("");
  const [phase, setPhase] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramMessageTemplate, setTelegramMessageTemplate] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState("custom");
  const [editLabel, setEditLabel] = useState("");
  const [editPhase, setEditPhase] = useState("");
  const [editSortOrder, setEditSortOrder] = useState(0);
  const [editTelegramEnabled, setEditTelegramEnabled] = useState(false);
  const [editTelegramMessageTemplate, setEditTelegramMessageTemplate] = useState("");

  async function loadTemplates() {
    const { data } = await supabase
      .from("moment_templates")
      .select("id, type, label_template, phase, sort_order, telegram_enabled, telegram_message_template")
      .order("sort_order", { ascending: true });
    setTemplates((data as Template[]) ?? []);
  }

  useEffect(() => {
    loadTemplates();
  }, []);

  const filtered = useMemo(
    () => (phaseFilter ? templates.filter((t) => t.phase === phaseFilter) : templates),
    [templates, phaseFilter]
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!labelTemplate.trim()) return;
    setLoading(true);
    setError(null);

    const { error } = await supabase.from("moment_templates").insert({
      type,
      label_template: labelTemplate.trim(),
      phase: phase || null,
      sort_order: sortOrder,
      telegram_enabled: telegramEnabled,
      telegram_message_template: telegramMessageTemplate.trim() || null,
    });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setLabelTemplate("");
    setSortOrder(0);
    setTelegramEnabled(false);
    setTelegramMessageTemplate("");
    loadTemplates();
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setEditType(t.type);
    setEditLabel(t.label_template);
    setEditPhase(t.phase ?? "");
    setEditSortOrder(t.sort_order);
    setEditTelegramEnabled(t.telegram_enabled);
    setEditTelegramMessageTemplate(t.telegram_message_template ?? "");
  }

  async function saveEdit(id: string) {
    const { error } = await supabase
      .from("moment_templates")
      .update({
        type: editType,
        label_template: editLabel,
        phase: editPhase || null,
        sort_order: editSortOrder,
        telegram_enabled: editTelegramEnabled,
        telegram_message_template: editTelegramMessageTemplate.trim() || null,
      })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setEditingId(null);
    loadTemplates();
  }

  async function deleteTemplate(id: string) {
    if (!confirm("Delete this template? This can't be undone.")) return;
    const { error } = await supabase.from("moment_templates").delete().eq("id", id);
    if (error) setError(error.message);
    else loadTemplates();
  }

  async function toggleTelegram(t: Template) {
    const { error } = await supabase.from("moment_templates").update({ telegram_enabled: !t.telegram_enabled }).eq("id", t.id);
    if (error) setError(error.message);
    else loadTemplates();
  }

  return (
    <div className="text-white space-y-6 max-w-3xl">
      <div>
        <h1 className="lv-heading text-lg">Moment templates</h1>
        <p className="text-xs text-white/40 mt-1">
          Prefilled moment-log entries the live console offers instead of free typing. Use{" "}
          <code className="text-white/60">{"{team}"}</code>, <code className="text-white/60">{"{hero}"}</code>, and{" "}
          <code className="text-white/60">{"{player}"}</code> as placeholders — the console fills them in from the
          match&apos;s own roster/hero data when a template is used. Scope a template to a phase so it only shows up
          when relevant, or leave phase as &quot;Any&quot;.
        </p>
      </div>

      <form onSubmit={handleAdd} className="grid grid-cols-2 gap-3 max-w-xl">
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-white/50">Label template</label>
          <input
            required
            value={labelTemplate}
            onChange={(e) => setLabelTemplate(e.target.value)}
            placeholder="e.g. Team {team} picks {hero}"
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Phase (optional)</label>
          <select
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          >
            <option value="">Any phase</option>
            {PHASES.map((p) => (
              <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-white/50">Sort order</label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm"
          />
        </div>
        <div className="col-span-2 flex items-center gap-1.5 pt-1">
          <input type="checkbox" checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} id="telegram-enabled" />
          <label htmlFor="telegram-enabled" className="text-xs text-white/50">Auto-post to Telegram when this is logged</label>
        </div>
        {telegramEnabled && (
          <div className="col-span-2 space-y-1">
            <label className="text-xs text-white/50">Telegram message template (optional — falls back to a default format)</label>
            <textarea
              value={telegramMessageTemplate}
              onChange={(e) => setTelegramMessageTemplate(e.target.value)}
              placeholder="e.g. 🔥 {team} just picked {hero}!"
              rows={2}
              className="w-full bg-black/30 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
            />
          </div>
        )}
        <button type="submit" disabled={loading} className="col-span-2 lv-btn-primary !py-2">
          Add template
        </button>
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <select
        value={phaseFilter}
        onChange={(e) => setPhaseFilter(e.target.value)}
        className="bg-black/30 border border-white/10 rounded px-3 py-1.5 text-sm"
      >
        <option value="">All phases</option>
        {PHASES.map((p) => (
          <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
        ))}
      </select>

      <table className="w-full text-sm">
        <thead className="text-white/40 text-left">
          <tr>
            <th className="font-normal pb-2">Label</th>
            <th className="font-normal pb-2">Type</th>
            <th className="font-normal pb-2">Phase</th>
            <th className="font-normal pb-2 w-16">Order</th>
            <th className="font-normal pb-2">Telegram</th>
            <th className="font-normal pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => (
            <tr key={t.id} className="border-t border-white/10">
              {editingId === t.id ? (
                <>
                  <td className="py-2 pr-2">
                    <input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    >
                      {TYPES.map((ty) => (
                        <option key={ty} value={ty}>{ty.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      value={editPhase}
                      onChange={(e) => setEditPhase(e.target.value)}
                      className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    >
                      <option value="">Any</option>
                      {PHASES.map((p) => (
                        <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="number"
                      value={editSortOrder}
                      onChange={(e) => setEditSortOrder(Number(e.target.value))}
                      className="w-16 bg-black/30 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="py-2 pr-2 space-y-1">
                    <label className="flex items-center gap-1 text-xs text-white/60">
                      <input type="checkbox" checked={editTelegramEnabled} onChange={(e) => setEditTelegramEnabled(e.target.checked)} />
                      Auto-post
                    </label>
                    {editTelegramEnabled && (
                      <textarea
                        value={editTelegramMessageTemplate}
                        onChange={(e) => setEditTelegramMessageTemplate(e.target.value)}
                        placeholder="Default format"
                        rows={2}
                        className="w-40 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs"
                      />
                    )}
                  </td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => saveEdit(t.id)} className="lv-btn-primary !px-2 !py-1">Save</button>
                    <button onClick={() => setEditingId(null)} className="lv-btn-ghost !px-2 !py-1">Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td className="py-2">{t.label_template}</td>
                  <td className="py-2 text-white/60 capitalize">{t.type.replace(/_/g, " ")}</td>
                  <td className="py-2 text-white/60">{t.phase ? t.phase.replace(/_/g, " ") : "Any"}</td>
                  <td className="py-2 text-white/40">{t.sort_order}</td>
                  <td className="py-2">
                    <label className="flex items-center gap-1 text-xs text-white/60 cursor-pointer" title={t.telegram_message_template ?? "Uses default message format"}>
                      <input type="checkbox" checked={t.telegram_enabled} onChange={() => toggleTelegram(t)} />
                      {t.telegram_enabled ? "On" : "Off"}
                    </label>
                  </td>
                  <td className="py-2 text-right space-x-2">
                    <button onClick={() => startEdit(t)} className="lv-btn-ghost !px-2 !py-1">Edit</button>
                    <button onClick={() => deleteTemplate(t.id)} className="lv-btn-danger !px-2 !py-1">Delete</button>
                  </td>
                </>
              )}
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-white/30 text-center">No templates yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
