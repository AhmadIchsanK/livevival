"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type TemplateRow = {
  id: string;
  type: string;
  phase: string | null;
  label_template: string;
  sort_order: number;
  telegram_enabled: boolean;
  telegram_message_template: string | null;
};

type EventDef = {
  type: string;
  phase: string | null;
  label: string;
  condition: string;
  defaultMessage: string;
};

// A curated list of the real system trigger points that are pure Telegram
// notifications — as opposed to /admin/moment-templates' full list, which
// is mostly moment-LOG entries (Savage, Maniac, pick/ban, custom...) the
// live console's manual picker shows during a broadcast. Each of these
// corresponds to an actual phase transition or result event the live
// console already fires from (see app/admin/matches/[id]/live/page.tsx —
// handlePhaseChange for the phase_notice rows, declareGameWinner /
// finalizeSeriesFinished for game_finish / match_finish), so "add a new
// notification" here means enabling one of these, not inventing an event
// with nothing to hook it to.
const EVENTS: EventDef[] = [
  {
    type: "phase_notice",
    phase: "DRAFT_STARTED",
    label: "Draft started",
    condition: "Sends when a game's phase moves to Draft started.",
    defaultMessage: "✏️ <b>Draft started — Game {game}</b>\n{team_a} vs {team_b}\n{tournament}",
  },
  {
    type: "phase_notice",
    phase: "DRAFT_COMPLETE",
    label: "Draft finished",
    condition: "Sends when the draft phase completes (picks/bans locked in).",
    defaultMessage: "📋 <b>Draft complete — Game {game}</b>\n{team_a} vs {team_b}\n{tournament}",
  },
  {
    type: "phase_notice",
    phase: "GAME_STARTED",
    label: "Game started",
    condition: "Sends when a game moves into Game ongoing.",
    defaultMessage: "🎮 <b>Game {game} ongoing</b>\n{team_a} vs {team_b}\n{tournament}",
  },
  {
    type: "game_finish",
    phase: null,
    label: "Game finished",
    condition: "Sends whenever a game's winner is declared — the Declare Winner buttons or a \"wins the game\" moment-log entry.",
    defaultMessage: "🎮 <b>Game result</b>\n{team_a} vs {team_b}\nWinner: <b>{winner}</b>\n{tournament}",
  },
  {
    type: "match_finish",
    phase: null,
    label: "Match finished",
    condition: "Sends once a team clinches the series — via Declare Winner, the phase dropdown's \"Series finished\", or a \"wins the match\" moment-log entry.",
    defaultMessage: "🏆 <b>Match finished</b>\n{team_a} vs {team_b}\nWinner: <b>{winner}</b>\n{tournament}",
  },
  {
    type: "phase_notice",
    phase: "TECHNICAL_PAUSE",
    label: "Technical pause",
    condition: "Sends when the phase is set to Technical pause.",
    defaultMessage: "⏸️ <b>Technical pause</b>\n{team_a} vs {team_b}\n{tournament}",
  },
  {
    type: "phase_notice",
    phase: "STREAM_ENDED",
    label: "Stream ended",
    condition: "Sends when the phase is set to Stream ended.",
    defaultMessage: "📴 <b>Stream ended</b>\n{team_a} vs {team_b}\n{tournament}",
  },
];

function keyFor(ev: EventDef) {
  return `${ev.type}:${ev.phase ?? "any"}`;
}

export default function TelegramNotificationsPage() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function load() {
    const { data, error } = await supabase
      .from("moment_templates")
      .select("id, type, phase, label_template, sort_order, telegram_enabled, telegram_message_template")
      .in("type", ["phase_notice", "game_finish", "match_finish"]);
    if (error) {
      setError(error.message);
      return;
    }
    setTemplates((data as TemplateRow[]) ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  function rowFor(ev: EventDef) {
    return templates.find((t) => t.type === ev.type && t.phase === ev.phase) ?? null;
  }

  async function setEnabled(ev: EventDef, enabled: boolean) {
    setError(null);
    const key = keyFor(ev);
    setBusyKey(key);
    const existing = rowFor(ev);
    const { error } = existing
      ? await supabase.from("moment_templates").update({ telegram_enabled: enabled }).eq("id", existing.id)
      : await supabase.from("moment_templates").insert({
          type: ev.type,
          phase: ev.phase,
          label_template: ev.label,
          sort_order: 0,
          telegram_enabled: enabled,
          telegram_message_template: null,
        });
    setBusyKey(null);
    if (error) {
      setError(error.message);
      return;
    }
    await load();
  }

  async function saveMessage(ev: EventDef) {
    setError(null);
    const key = keyFor(ev);
    const text = (drafts[key] ?? "").trim();
    setBusyKey(key);
    const existing = rowFor(ev);
    const { error } = existing
      ? await supabase.from("moment_templates").update({ telegram_message_template: text || null }).eq("id", existing.id)
      : await supabase.from("moment_templates").insert({
          type: ev.type,
          phase: ev.phase,
          label_template: ev.label,
          sort_order: 0,
          telegram_enabled: true,
          telegram_message_template: text || null,
        });
    setBusyKey(null);
    if (error) {
      setError(error.message);
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await load();
  }

  return (
    <div className="text-white space-y-6 max-w-3xl">
      <div>
        <h1 className="lv-heading text-lg">Telegram notifications</h1>
        <p className="text-xs text-white/40 mt-1">
          Auto-posted Telegram messages for match phase changes and results — draft/game/match finish and the rest.
          Separate from <a href="/admin/moment-templates" className="text-signal hover:underline">Moment Templates</a>,
          which is for the live console&apos;s manual moment-log picker (Savage, Maniac, pick/ban, custom notes).
          Toggle an event on to start sending it, edit its message any time, or toggle it off to stop — nothing here
          sends unless the toggle is on. Placeholders: <code className="text-white/60">{"{team_a}"}</code>,{" "}
          <code className="text-white/60">{"{team_b}"}</code>, <code className="text-white/60">{"{tournament}"}</code>,{" "}
          <code className="text-white/60">{"{winner}"}</code>, <code className="text-white/60">{"{game}"}</code>, and{" "}
          <code className="text-white/60">{"{timestamp}"}</code>. Leave the message blank to use the built-in default
          shown as a placeholder.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="space-y-3">
        {EVENTS.map((ev) => {
          const row = rowFor(ev);
          const key = keyFor(ev);
          const enabled = row?.telegram_enabled ?? false;
          const draftValue = drafts[key] ?? row?.telegram_message_template ?? "";
          const dirty = key in drafts;
          return (
            <div key={key} className="border border-white/10 rounded p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm">{ev.label}</p>
                  <p className="text-xs text-white/40 mt-0.5">{ev.condition}</p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-white/60 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busyKey === key}
                    onChange={(e) => setEnabled(ev, e.target.checked)}
                  />
                  Send to Telegram
                </label>
              </div>
              {enabled && (
                <div className="flex gap-2 items-start">
                  <textarea
                    value={draftValue}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={ev.defaultMessage}
                    rows={2}
                    className="flex-1 bg-white/10 border border-white/10 rounded px-3 py-2 text-sm outline-none focus:border-signal"
                  />
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => saveMessage(ev)}
                      disabled={busyKey === key || !dirty}
                      className="lv-btn-primary !px-3 !py-1.5 disabled:opacity-40"
                    >
                      {busyKey === key ? "..." : "Save"}
                    </button>
                    {row?.telegram_message_template && (
                      <button
                        onClick={() => setDrafts((prev) => ({ ...prev, [key]: "" }))}
                        className="text-xs text-white/40 hover:text-white/70"
                        title="Clear custom text — falls back to the default message"
                      >
                        Reset to default
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
