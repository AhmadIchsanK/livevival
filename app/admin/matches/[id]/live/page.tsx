"use client";

import { useEffect, useState, useCallback, useRef, Fragment, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { createWorker } from "tesseract.js";
import { TeamLogo } from "@/components/TeamLogo";
import { HeroIcon } from "@/components/HeroIcon";
import { DraftOverlay, type DraftOverlayPickBan, type DraftOverlaySlotAction, type DraftOverlayPlayer } from "@/components/DraftOverlay";
import { getLegalTransitions, type MatchPhase, type PhaseSignals } from "@/lib/matchPhase";
import { PhaseStepper } from "@/components/PhaseStepper";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";
import { displayMatchTier, matchTierFields, MATCH_TIER_LABELS, type MatchTier } from "@/lib/matchTier";

// CSS custom properties aren't part of React's CSSProperties type — this
// widens it just enough to set/read `--lv-admin-header-h` (see adminHeaderH)
// without an `any` cast.
type CSSPropertiesWithVars = CSSProperties & Record<`--${string}`, string>;

// Auto-detected moment triggers only — narrowed to the four kill-streak
// callouts (each still requires a player name attached, extracted by the
// kill_banner OCR handler from the text preceding whatever matched here).
// Kill streaks/ace/lord-turtle-steal detection removed per product
// decision — those stay available as admin-clickable moment-template
// buttons (unaffected, not driven by this array), just no longer
// auto-suggested from OCR. The popup-confirm UX that reads off this array
// is unchanged — only what can trigger it got narrower.
const OCR_KEYWORDS: { pattern: RegExp; type: string }[] = [
  { pattern: /SAVAGE/i, type: "savage" },
  { pattern: /MANIAC/i, type: "maniac" },
  { pattern: /TRIPLE\s*KILL/i, type: "triple_kill" },
  { pattern: /DOUBLE\s*KILL/i, type: "double_kill" },
];

// A contributor reaches this exact page (not a separate clone) once
// approved, but only ever for a finished match, and never writes directly
// — every write call-site below forks on actorType and buffers into
// pendingMatchEdits instead, bundled into one edit_requests row on submit.
// See the route guard right after the match/game load-guard below.
type ActorType = "admin" | "contributor";
type MatchEditEntry = {
  table: string;
  action: "insert" | "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

type Match = {
  id: string;
  youtube_url: string | null;
  format: string | null;
  current_game_number: number;
  status: string;
  state: string;
  custom_state_label: string | null;
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
  series_winner_team_id: string | null;
  tournament_id: string | null;
  ocr_left_team_id: string | null;
  tournament: { name: string; liquipedia_slug: string | null } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type Player = { id: string; team_id: string; ign: string; role: string | null; photo_url: string | null; is_active_roster: boolean };
type Game = {
  id: string;
  game_number: number;
  status: string;
  map: string | null;
  winner_team_id: string | null;
  clock_source: "ocr" | "manual";
  manual_time_seconds: number | null;
  manual_time_running: boolean;
  manual_time_started_at: string | null;
  current_time_seconds: number | null;
  current_time_updated_at: string | null;
  team_a_kills_override: number | null;
  team_b_kills_override: number | null;
};
type FinishedGame = { id: string; game_number: number; status: string; map: string | null; winner_team_id: string | null; duration_seconds: number | null };
// custom_player_name/custom_player_role: a match-local player who isn't in
// the `players` table roster at all (last-minute sub, scrim player, etc.) —
// set instead of player_id, never both. See the note by isCustomPlayerId
// below for how this flows into the scoreboard.
type PickBan = {
  id: string;
  team_id: string;
  player_id: string | null;
  hero_name: string;
  type: "pick" | "ban";
  pick_order: number | null;
  custom_player_name: string | null;
  custom_player_role: string | null;
};
// kills/deaths/assists are nullable — null means "TBD, not yet entered" so
// the scoreboard can tell "genuinely 0" apart from "nobody's typed
// anything here yet." The headline team score never depends on these being
// filled in — team_a/b_kills_override (the team_kills tracker, or a manual
// edit) is always preferred over summing per-player rows when present.
// player_id is null (with custom_player_name set instead) for a match-local
// custom player's stat row — see the note by PickBan's custom_player_name.
type PlayerStat = {
  id: string;
  player_id: string | null;
  hero_name: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  gold: number;
  custom_player_name: string | null;
};
type Objective = { id: string; team_id: string; type: string; minute_mark: number | null; created_at: string };
type NetWorthSnapshot = { minute_mark: number; team_a_gold: number; team_b_gold: number };
type KeyMoment = {
  id: string;
  type: string;
  player_id: string | null;
  team_id: string | null;
  description: string | null;
  minute_mark: number | null;
  is_key_moment: boolean;
  screenshot_url: string | null;
};
type MomentTemplate = {
  id: string;
  type: string;
  label_template: string;
  phase: string | null;
  telegram_enabled: boolean;
  telegram_message_template: string | null;
};
type Screenshot = { id: string; image_url: string; in_game_time: string | null; note: string | null; created_at: string };

// The handful of genuinely dramatic moment types that stand out inline in
// the moment list — everything else (phase changes, picks, custom notes)
// still appears in the same feed, just styled as a regular line item.
const KEY_MOMENT_TYPES = ["savage", "maniac", "double_kill", "triple_kill", "lord_steal", "turtle_steal", "ace"];

// Only GAME_STARTED ever has an OCR tracker worth running — the game
// clock, kills, net worth, and K/D/A only exist on screen once the game has
// actually started. Every other phase (draft, pre-game countdown,
// technical pause, finished, custom) is driven by the admin's own manual
// controls instead, so the phase dropdowns below (add tracker / canvas
// filter / phase filter) never offer them — narrower than the general
// match-phase selector further up, which still needs the full set.
// TECHNICAL_PAUSE previously appeared here too (a "pause" word tracker was
// planned) but catalogForPhase never actually offered anything for it —
// the broadcast HUD trackers are calibrated against isn't even on screen
// during a pause, so it's been removed rather than left as a phase that
// looks trackable but never has anything to add.
const TRACKER_PHASES = ["GAME_STARTED"];

// Fallback label text for a detected moment when no /admin/moment-templates
// row exists for its type yet — escalating kill-streak flair per an
// explicit site-owner example (Double Kill2️⃣, Triple Kill3️⃣, Maniac💀,
// 🔥SAVAGE!!🔥). A configured template row always wins over this.
const DEFAULT_MOMENT_LABELS: Record<string, string> = {
  double_kill: "{player} Double Kill 2️⃣",
  triple_kill: "{player} Triple Kill 3️⃣",
  maniac: "{player} goes MANIAC 💀",
  savage: "🔥 {player} SAVAGE!! 🔥",
  lord_steal: "Lord slain!",
  turtle_steal: "Turtle slain!",
  ace: "ACE!",
};

// Same fixed left-to-right draft order used across the admin (Players page
// role dropdown): exp lane, jungler, mid laner, roamer, gold laner —
// confirmed against the real broadcast overlay order, which had roamer
// before gold laner (was previously the other way around).
const ROLE_ORDER = ["Exp Laner", "Jungler", "Mid Laner", "Roamer", "Gold Laner"];
const MAPS = ["Expanding Rivers", "Flying Cloud", "Dangerous Grass"];
function roleIndex(role: string | null) {
  const i = ROLE_ORDER.indexOf(role ?? "");
  return i === -1 ? ROLE_ORDER.length : i;
}

function youtubeEmbedUrl(url: string | null) {
  if (!url) return null;
  const idMatch = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return idMatch ? `https://www.youtube.com/embed/${idMatch[1]}` : null;
}
// Same Facebook embed-plugin fallback as the public match page — the
// admin's own preview iframe was silently blank for a Facebook-hosted
// stream even though the public page (before this) had the exact same gap.
function facebookEmbedUrl(url: string | null) {
  if (!url) return null;
  if (!/facebook\.com|fb\.watch/i.test(url)) return null;
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
}

// A native <select> renders its open dropdown as an OS-level popup
// window in most browsers — on Windows especially, that popup stealing
// window-manager focus is enough to force a *different*, unrelated
// window (e.g. the admin's screen-shared livestream, fullscreened on a
// second monitor) out of exclusive fullscreen back to windowed. This
// in-page listbox never leaves the DOM/JS world — clicking it opens a
// normal absolutely-positioned <div>, not a native popup — so it can't
// have that side effect. Used anywhere on this page an admin is likely
// to reach for a dropdown while capture/the livestream is running.
// Both InlineMenuSelect and InlineMenuPopover render their open panel
// through a React portal straight onto document.body, positioned via
// fixed pixel coordinates from the trigger's own bounding rect, instead
// of a normal absolutely-positioned child. This is necessary, not just
// nicer: both are used inside a toolbar (see the sticky div around line
// 6554) that's `position: sticky; z-index: 10`, nested under several
// plain non-positioned divs below the page's own admin header (see
// adminHeaderRef, `position: sticky; z-index: 20`). Neither sticky
// element is a descendant of the other, and nothing between them
// establishes its own stacking context — so per CSS stacking rules, the
// toolbar's ENTIRE subtree is capped at its own z-10 slot when compared
// against the header's z-20 context, no matter what z-index a normal
// (non-portaled) descendant declares locally. A panel with `z-20` nested
// three levels inside a `z-10` ancestor still loses to a sibling `z-20`
// context — that "local" z-20 only wins fights within the z-10 slot, it
// can't escape it. Portaling to <body> sidesteps the whole problem: the
// panel becomes a sibling of the header in the stacking order instead of
// a great-grandchild of a lower-z-index ancestor, free to out-rank it
// with a plain z-index number again.
function usePopoverPosition(triggerRef: RefObject<HTMLElement | null>, open: boolean) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    function update() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    update();
    // capture:true — the toolbar's own ancestor is a scrollable pane
    // (overflow-y-auto), whose scroll events don't bubble to window in
    // the normal phase; capture-phase listening on window still sees them.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, triggerRef]);
  return pos;
}

function InlineMenuSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
  title,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(buttonRef, open);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div className={`inline-block ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs text-left flex items-center justify-between gap-1.5 whitespace-nowrap hover:bg-white/15"
      >
        <span className="truncate">{current?.label ?? placeholder ?? "Select..."}</span>
        <span className="text-white/40 shrink-0">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
            className="z-[100] max-h-64 overflow-y-auto bg-[#111116] border border-white/15 rounded shadow-lg py-1"
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`block w-full text-left px-2.5 py-1.5 text-xs whitespace-nowrap hover:bg-white/10 ${
                  opt.value === value ? "text-signal font-semibold" : "text-white/80"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

// A compact toolbar trigger that opens a floating panel of arbitrary
// content (a mix of dropdowns/inputs/buttons that wouldn't fit as
// standalone toolbar items) — used to fold the Templates and Captured-area
// controls (previously two whole separate rows below the toolbar) into
// single buttons on the sticky toolbar itself. `forceOpen` keeps the panel
// open and immune to the outside-click-closes handler regardless of the
// trigger click — used for Captured area, whose Lock/Cancel controls need
// to stay visible for the whole duration of a canvas drag (which happens
// outside this component's own DOM, so an outside-click-closes listener
// would otherwise close the panel the instant the drag starts).
function InlineMenuPopover({
  label,
  icon,
  accentClassName,
  forceOpen,
  children,
}: {
  label: string;
  icon?: string;
  accentClassName?: string;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isOpen = open || !!forceOpen;
  const pos = usePopoverPosition(buttonRef, isOpen);
  useEffect(() => {
    if (!isOpen || forceOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [isOpen, forceOpen]);
  return (
    <div className="inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={`text-xs rounded px-3 py-1.5 border whitespace-nowrap ${accentClassName ?? "border-white/20 text-white/70 hover:bg-white/10"}`}
      >
        {icon ? `${icon} ` : ""}
        {label} ▾
      </button>
      {isOpen &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: Math.max(pos.width, 300) }}
            className="z-[100] bg-[#111116] border border-white/15 rounded shadow-lg p-3 space-y-2"
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}

export default function LiveConsolePage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [pastGames, setPastGames] = useState<FinishedGame[]>([]);
  // Which game_number the console is actually viewing/editing — defaults to
  // the match's live current_game_number on first load, but the admin can
  // switch it to any finished/ongoing/upcoming game via the selector below.
  // Everything that operates on "game" (moment list, scoreboard, hero
  // picks/bans, net worth, screenshots) follows whichever one this is set
  // to, not necessarily the live one.
  const [selectedGameNumber, setSelectedGameNumber] = useState<number | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [pickBans, setPickBans] = useState<PickBan[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  // Auto-scrolls the Moment Timeline list to its newest (bottom) entry on
  // every update — same behavior as the public match page's own Moment
  // Timeline (see momentListRef there), which already did this. The admin
  // side's list didn't, so a live-logging admin had to keep manually
  // scrolling down to see the moment they just logged.
  const adminMomentListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = adminMomentListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [keyMoments.length]);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthSnapshot[]>([]);
  const [minute, setMinute] = useState(0);
  // Companion to `minute` — kept separately rather than changing what
  // `minute` means everywhere, since minute_mark (whole minutes) is still
  // the right grain for most of this file's existing call sites. Only
  // key_moments' new second_mark column needs the sub-minute precision.
  const [secondOfMinute, setSecondOfMinute] = useState(0);
  const mmssTimestamp = () => `${String(minute).padStart(2, "0")}:${String(secondOfMinute).padStart(2, "0")}`;
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Monitor/action-deck split ratio — admin-adjustable (min 20% a side, so
  // neither pane can be squeezed unusably thin), persisted per-browser so
  // it doesn't reset every visit. Replaces the old fixed 60/40 grid-cols
  // split.
  const [splitLeftPct, setSplitLeftPct] = useState(60);
  useEffect(() => {
    const saved = Number(localStorage.getItem("lv-admin-split-left-pct"));
    if (Number.isFinite(saved) && saved >= 20 && saved <= 80) setSplitLeftPct(saved);
  }, []);
  function applySplit(leftPct: number) {
    const clamped = Math.max(20, Math.min(80, Math.round(leftPct)));
    setSplitLeftPct(clamped);
    localStorage.setItem("lv-admin-split-left-pct", String(clamped));
  }

  // Measures the sticky top header's real rendered height (it wraps to a
  // different number of lines depending on match state/badges) so the
  // monitor pane's own `sticky top-[...]` offset in the 60/40 layout below
  // can sit exactly beneath it instead of guessing a fixed pixel value.
  const adminHeaderRef = useRef<HTMLDivElement>(null);
  const [adminHeaderH, setAdminHeaderH] = useState(0);
  useEffect(() => {
    const el = adminHeaderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAdminHeaderH(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── Undo (Ctrl+Z) for the most recently logged event ──────────────────
  // Deliberately single-level, not a full undo stack — every write site
  // that wires in just overwrites whatever was here before, so Ctrl+Z
  // always undoes only the single most recent action, per the "keep this
  // simple" ask. "insert" deletes the row outright; "update" restores
  // whatever the field held immediately before that write. Wired into the
  // handful of write paths that represent a genuine "logged event" an
  // operator would actually want to walk back (key moments, objectives) —
  // not every write on the page.
  type LastAction =
    | { table: string; id: string; label: string; kind: "insert" }
    | { table: string; id: string; label: string; kind: "update"; column: string; previousValue: unknown };
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);
  async function undoLastAction() {
    if (!lastAction) return;
    const { error: undoError } =
      lastAction.kind === "insert"
        ? await supabase.from(lastAction.table).delete().eq("id", lastAction.id)
        : await supabase.from(lastAction.table).update({ [lastAction.column]: lastAction.previousValue }).eq("id", lastAction.id);
    if (undoError) {
      setError(undoError.message);
      return;
    }
    setUndoStatus(`Undid: ${lastAction.label}`);
    setTimeout(() => setUndoStatus(null), 3000);
    setLastAction(null);
    loadAll();
  }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl+Z on Windows/Linux, Cmd+Z on Mac — skipped entirely while
      // focus is in a text input/textarea so it doesn't fight the
      // browser's own native undo inside whatever field is being typed
      // into (e.g. correcting a moment description).
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !isTyping) {
        e.preventDefault();
        undoLastAction();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAction]);

  // Defaults to "admin" — this page lives under /admin, so every existing
  // write call-site's behavior is unchanged unless this flips. It only
  // flips for a session with an approved contributors row and no admins
  // row (an admin who happens to also have a stale contributor row still
  // gets full admin behavior, checked first).
  const [actorType, setActorType] = useState<ActorType>("admin");
  const [contributorId, setContributorId] = useState<string | null>(null);
  const [pendingMatchEdits, setPendingMatchEdits] = useState<MatchEditEntry[]>([]);
  const [submittingMatchEdits, setSubmittingMatchEdits] = useState(false);
  const [matchEditSubmitNotice, setMatchEditSubmitNotice] = useState<string | null>(null);
  const isContributor = actorType === "contributor";

  // Bundles every buffered {table, action, before, after} entry from this
  // session into one edit_requests row — admin approval (app/admin/
  // contributor-requests) replays each entry as the real write. Soft
  // "stop" semantics: submitting doesn't clear editingFinishedGame, so a
  // contributor can keep staging more changes in the same session if the
  // submit fails partway (network error, RLS surprise) without losing
  // anything already staged.
  async function submitMatchEditRequest() {
    if (pendingMatchEdits.length === 0 || !contributorId) return;
    setSubmittingMatchEdits(true);
    setMatchEditSubmitNotice(null);
    const { error } = await supabase.from("edit_requests").insert({
      contributor_id: contributorId,
      entity_type: "match_live_edit",
      entity_id: matchId,
      action: "update",
      proposed_changes: { edits: pendingMatchEdits },
    });
    setSubmittingMatchEdits(false);
    if (error) {
      setMatchEditSubmitNotice(`Failed to submit: ${error.message}`);
      return;
    }
    setPendingMatchEdits([]);
    setMatchEditSubmitNotice("Submitted for review.");
  }

  useEffect(() => {
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) return;
      const { data: adminRow } = await supabase.from("admins").select("id").eq("user_id", userId).maybeSingle();
      if (adminRow) return;
      const { data: contributorRow } = await supabase
        .from("contributors")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "approved")
        .maybeSingle();
      if (contributorRow) {
        setActorType("contributor");
        setContributorId((contributorRow as { id: string }).id);
      }
    })();
  }, []);

  // Locally-generated ids for rows a contributor "creates" without ever
  // touching the DB — only used to key React lists / reference the row
  // again within the same session (e.g. deleting a pick they just staged);
  // never sent anywhere as a real foreign key.
  function fakeId() {
    return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function pushPendingEdit(entry: MatchEditEntry) {
    setPendingMatchEdits((prev) => [...prev, entry]);
  }

  const loadAll = useCallback(async () => {
    const { data: matchData, error: matchErr } = await supabase
      .from("matches")
      .select(
        `id, youtube_url, format, current_game_number, status, state, custom_state_label, update_source, notification_tier, series_winner_team_id, tournament_id, ocr_left_team_id,
         tournament:tournaments(name, liquipedia_slug),
         team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
         team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`
      )
      .eq("id", matchId)
      .single();

    if (matchErr || !matchData) {
      setError(matchErr?.message ?? "Match not found");
      return;
    }
    const m = matchData as unknown as Match;
    setMatch(m);

    // First load has no explicit selection yet — default to the match's
    // live game, same as before this selector existed. Once the admin
    // picks a different one, reloads (loadAll re-runs after every write)
    // keep following that choice instead of snapping back to current.
    const targetGameNumber = selectedGameNumber ?? m.current_game_number;
    if (selectedGameNumber === null) setSelectedGameNumber(m.current_game_number);

    let { data: gameRow } = await supabase
      .from("games")
      .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at, team_a_kills_override, team_b_kills_override")
      .eq("match_id", matchId)
      .eq("game_number", targetGameNumber)
      .maybeSingle();

    if (!gameRow) {
      // Only the live game_number starts "live" — anything else picked
      // from the selector before it's actually been reached is a genuine
      // placeholder (an admin pre-staging a future game's picks/bans),
      // not something the public page should treat as in progress. "draft"
      // (not "scheduled") is the only other value games_status_check
      // allows, matching the state column's own 'DRAFT_STARTED' default.
      // upsert with onConflict (not a plain insert) so a second loadAll()
      // firing for the same match/game before this one lands — two tabs,
      // a double-invoked effect — reconciles instead of hitting
      // games_match_id_game_number_key.
      const { data: created, error: createErr } = await supabase
        .from("games")
        .upsert(
          { match_id: matchId, game_number: targetGameNumber, status: targetGameNumber === m.current_game_number ? "live" : "draft" },
          { onConflict: "match_id,game_number" }
        )
        .select("id, game_number, status, map, winner_team_id, clock_source, manual_time_seconds, manual_time_running, manual_time_started_at, current_time_seconds, current_time_updated_at, team_a_kills_override, team_b_kills_override")
        .single();
      if (createErr) {
        setError(createErr.message);
        return;
      }
      gameRow = created;
    }
    setGame(gameRow as Game);

    const { data: past } = await supabase
      .from("games")
      .select("id, game_number, status, map, winner_team_id, duration_seconds")
      .eq("match_id", matchId)
      .neq("id", (gameRow as Game).id)
      .order("game_number");
    setPastGames((past as FinishedGame[]) ?? []);

    const teamIds = [m.team_a?.id, m.team_b?.id].filter(Boolean) as string[];
    const { data: playerRows } = await supabase
      .from("players")
      .select("id, team_id, ign, role, photo_url, is_active_roster")
      .in("team_id", teamIds);
    setPlayers((playerRows as Player[]) ?? []);

    if (gameRow) {
      const gid = (gameRow as Game).id;
      const [{ data: pb }, { data: ps }, { data: obj }, { data: km }, { data: ss }, { data: nw }] = await Promise.all([
        supabase.from("hero_picks_bans").select("id, team_id, player_id, hero_name, type, pick_order, custom_player_name, custom_player_role").eq("game_id", gid).order("pick_order"),
        supabase.from("player_stats").select("id, player_id, hero_name, kills, deaths, assists, gold, custom_player_name").eq("game_id", gid),
        supabase.from("objectives").select("id, team_id, type, minute_mark, created_at").eq("game_id", gid).order("minute_mark"),
        supabase.from("key_moments").select("id, type, player_id, team_id, description, minute_mark, is_key_moment, screenshot_url").eq("game_id", gid).order("minute_mark"),
        supabase.from("game_screenshots").select("id, image_url, in_game_time, note, created_at").eq("game_id", gid).order("created_at"),
        supabase.from("net_worth_snapshots").select("minute_mark, team_a_gold, team_b_gold").eq("game_id", gid).order("minute_mark"),
      ]);
      setPickBans((pb as PickBan[]) ?? []);
      setStats((ps as PlayerStat[]) ?? []);
      setObjectives((obj as Objective[]) ?? []);
      setKeyMoments((km as KeyMoment[]) ?? []);
      setScreenshots((ss as Screenshot[]) ?? []);
      setNetWorth((nw as NetWorthSnapshot[]) ?? []);
    }
  }, [matchId, selectedGameNumber]);

  // Chronological-error fix: selectedGameNumber is deliberately "sticky"
  // (see its own comment above) so browsing an older game survives
  // realtime reloads — but that also meant it silently stayed pinned to
  // the just-finished game after declareGameWinner advances
  // match.current_game_number server-side. An admin who clicked "Declare
  // Game Winner" then "Start draft" from the phase stepper was drafting
  // back into Game 1 instead of Game 2, since `game` never followed the
  // server's own current_game_number forward. Only auto-follows when the
  // admin was actually looking at the live game when it advanced (their
  // selection equals the *previous* current_game_number) — deliberately
  // reviewing an older game is untouched by this.
  const prevCurrentGameNumberRef = useRef<number | null>(null);
  useEffect(() => {
    if (!match) return;
    const prev = prevCurrentGameNumberRef.current;
    if (prev !== null && prev !== match.current_game_number && selectedGameNumber === prev) {
      setSelectedGameNumber(match.current_game_number);
    }
    prevCurrentGameNumberRef.current = match.current_game_number;
  }, [match?.current_game_number, selectedGameNumber, match]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    autoStartedGameId.current = null;
  }, [game?.id]);

  // ── Telegram (admin-triggered) ───────────────────────────────────────
  // For matches on Liquipedia auto-sync, the worker posts match-live/
  // game-result/match-finished automatically. This is for what it can't:
  // draft recaps and key moments (Liquipedia has no live picks/bans feed
  // for an in-progress series — only once the whole match is marked
  // finished), and anything on a local_ocr match, which the worker skips
  // entirely since the admin's local capture session owns it.
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  async function postToTelegram(message: string, meta?: { entityType: string; entityId: string; notificationType: string }, photoUrl?: string) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setTelegramStatus("Not signed in.");
      return;
    }
    // Every Telegram post sent while the game is actually ongoing gets the
    // current timestamp appended — not just the one dedicated template.
    const fullMessage = match?.state === "GAME_STARTED" ? `${message}\n⏱ ${mmssTimestamp()}` : message;
    const res = await fetch("/api/telegram/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: fullMessage, matchId, photoUrl, ...meta }),
    });
    const data = await res.json();
    setTelegramStatus(res.ok ? "Posted to Telegram." : data.error ?? "Failed to post.");
    setTimeout(() => setTelegramStatus(null), 4000);
    return res.ok;
  }

  // Dispatches scripts/sync-hot-match-picks-bans.mjs (via
  // .github/workflows/sync-hot-match-draft.yml) for this one match — see
  // that script's module comment for why it only ever corrects which hero
  // was picked/banned, never kill stats, the moment list, or match/game
  // state. Runs in the background like every other Liquipedia sync
  // trigger in this app (see app/admin/data-sync/page.tsx) — this button
  // just kicks it off, the admin reloads the page a minute or two later to
  // see any corrections land.
  async function syncDraftFromLiquipedia() {
    setSyncingDraft(true);
    setSyncDraftStatus("");
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setSyncDraftStatus("Not signed in.");
      setSyncingDraft(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/sync-hot-match-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ matchId }),
      });
      const data = await res.json().catch(() => ({}));
      setSyncDraftStatus(res.ok ? "Triggered — reload in a minute or two to see any corrections." : data.error ?? "Failed to trigger.");
    } catch (err) {
      setSyncDraftStatus((err as Error).message);
    } finally {
      setSyncingDraft(false);
    }
  }

  // Builds the same "team → picks/bans" recap block used both by the manual
  // "Announce draft" button and the automatic draft-finished notification.
  function buildDraftRecap(): string {
    if (!match) return "";
    return [match.team_a, match.team_b]
      .map((team) => {
        if (!team) return "";
        // Falls back to the pick-ban row's own custom_player_role/name for
        // a match-local custom player (no `players` row to look up).
        const roleFor = (pb: PickBan) => players.find((p) => p.id === pb.player_id)?.role ?? pb.custom_player_role ?? null;
        const nameFor = (pb: PickBan) => players.find((p) => p.id === pb.player_id)?.ign ?? pb.custom_player_name ?? "?";
        const picks = pickBans
          .filter((pb) => pb.team_id === team.id && pb.type === "pick")
          .sort((a, b) => roleIndex(roleFor(a)) - roleIndex(roleFor(b)))
          .map((pb) => `- ${pb.hero_name} (${nameFor(pb)})`)
          .join("\n");
        const bans = pickBans.filter((pb) => pb.team_id === team.id && pb.type === "ban").map((pb) => pb.hero_name).join(", ");
        return `<b>${team.name}</b>\nPicks:\n${picks || "—"}\nBans: ${bans || "—"}`;
      })
      .join("\n\n");
  }

  // Full-series hero-picks recap for the automatic match-finished
  // notification (Priority and Hot tiers both get this) — same
  // team->picks textual convention as buildDraftRecap above, but pulled
  // fresh per game across the whole series rather than just the
  // currently-loaded game's pickBans state, since by the time a series
  // finishes every earlier game's picks need to show up too.
  async function buildSeriesHeroRecap(): Promise<string> {
    if (!match?.team_a || !match?.team_b) return "";
    const { data: seriesGames } = await supabase
      .from("games")
      .select("id, game_number, map")
      .eq("match_id", match.id)
      .order("game_number");
    if (!seriesGames || seriesGames.length === 0) return "";

    const blocks: string[] = [];
    for (const g of seriesGames as { id: string; game_number: number; map: string | null }[]) {
      const { data: pbs } = await supabase
        .from("hero_picks_bans")
        .select("team_id, hero_name, type")
        .eq("game_id", g.id)
        .eq("type", "pick");
      const aPicks = (pbs ?? []).filter((pb) => pb.team_id === match.team_a!.id).map((pb) => pb.hero_name).join(", ") || "—";
      const bPicks = (pbs ?? []).filter((pb) => pb.team_id === match.team_b!.id).map((pb) => pb.hero_name).join(", ") || "—";
      blocks.push(`<b>Game ${g.game_number}</b>${g.map ? ` (${g.map})` : ""}\n${match.team_a!.name}: ${aPicks}\n${match.team_b!.name}: ${bPicks}`);
    }
    return blocks.join("\n\n");
  }

  // Games each team has already won, excluding whichever game is in
  // progress right now (it has no winner_team_id yet) — the "current
  // score" line on phase-notice Telegram messages.
  function seriesScoreLine(): string {
    if (!match?.team_a || !match?.team_b) return "";
    const aWins = pastGames.filter((g) => g.winner_team_id === match.team_a!.id).length;
    const bWins = pastGames.filter((g) => g.winner_team_id === match.team_b!.id).length;
    return `${match.team_a.name} ${aWins} - ${bWins} ${match.team_b.name}`;
  }

  // "All 10 players have a hero decided" — each side's starting five
  // (same deterministic role-ordered slots the draft_hero_pick trackers
  // resolve against) must have a logged pick for this game, regardless of
  // whether that pick came from OCR, AI vision, or a manual edit.
  // SAVE — the single "I'm done with the draft" action: (a) posts the same
  // draft recap "Announce draft" already sends (via postToTelegram, which
  // itself mirrors to Slack server-side — see /api/telegram/notify — no
  // separate Slack call needed here), then (b) advances match.state to
  // GAME_STARTED through the existing setMatchPhase transition function
  // rather than a raw update, so it picks up the same phase-notice
  // Telegram post and key_moments phase_change log every other transition
  // already gets, instead of a one-off that skips those side effects.
  // A pick shown as "· auto" on the draft board (DraftOverlay's own
  // positional-fallback match: this team's Nth still-unassigned pick, by
  // pick_order, matched to the Nth player in role order) reads as
  // resolved on screen but was never actually written to that pick's
  // player_id — draftFullyResolved() (and anything downstream keyed off
  // player_id: K/D/A trackers, map sync) only sees a real assignment, not
  // the positional guess. That's the "left on auto, draft still errors"
  // bug: nothing was wrong with the pick, it just never got locked in.
  // Not every pick needs a manual adjustment — this locks in exactly the
  // same pairing the board is already showing, using the identical
  // algorithm (see DraftOverlay's unassignedPicksFor/renderPlayers), so
  // there's no behavior change for the admin, just the write that was
  // missing.
  async function lockInPositionalPicks(): Promise<PickBan[]> {
    let merged = pickBans;
    if (!match?.team_a || !match?.team_b) return merged;
    for (const teamId of [match.team_a.id, match.team_b.id]) {
      // is_active_roster, not raw team_id membership — a team can carry
      // more than 5 rows (bench/subs), and without this filter a stray
      // extra player can land in the role-ordered top 5 instead of one of
      // the admin's actual designated starters (see toggleActiveRoster).
      const teamPlayers = players.filter((p) => p.team_id === teamId && p.is_active_roster).sort((a, b) => roleIndex(a.role) - roleIndex(b.role)).slice(0, 5);
      const fallbackQueue = merged
        .filter((pb) => pb.type === "pick" && pb.team_id === teamId && !pb.player_id)
        .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
      let idx = 0;
      for (const p of teamPlayers) {
        if (merged.some((pb) => pb.type === "pick" && pb.player_id === p.id)) continue; // already has a real assignment
        if (idx >= fallbackQueue.length) continue; // no pick left to positionally match
        const pb = fallbackQueue[idx];
        idx++;
        await supabase.from("hero_picks_bans").update({ player_id: p.id }).eq("id", pb.id);
        merged = merged.map((row) => (row.id === pb.id ? { ...row, player_id: p.id } : row));
        // Same write assignHeroToPlayer does for a manually-assigned pick —
        // without this, a positionally-locked pick never gets a
        // player_stats row, so Hero shows blank on the scoreboard and the
        // public match page (which reads player_stats, not
        // hero_picks_bans) never sees the pick at all.
        await updateStat(p.id, "hero_name", pb.hero_name);
      }
    }
    setPickBans(merged);
    return merged;
  }

  // player_stats.hero_name previously only ever got set as a side effect of
  // correctPickBanHero (an admin manually reassigning a hero) — a pick
  // that was correctly drafted from the start and never touched again had
  // no hero on its player_stats row at all, since nothing else ever wrote
  // it there. That's the "hero disappears once the game starts" bug: the
  // Draft board reads hero straight from hero_picks_bans (always correct),
  // but the Live Scoreboard (both here and on the public page) reads it
  // from player_stats, which stayed null. Runs once, right as the draft is
  // saved, so every starter's row has its hero from the start regardless
  // of whether it was ever manually corrected.
  async function syncDraftHeroesToStats(pickBansSnapshot: PickBan[]) {
    for (const pb of pickBansSnapshot) {
      if (pb.type !== "pick") continue;
      const playerId = pb.player_id ?? (pb.custom_player_name ? `custom:${pb.id}` : null);
      if (!playerId) continue;
      await ensureStatRow(playerId);
      await updateStat(playerId, "hero_name", pb.hero_name);
    }
  }

  async function saveDraftAndStartGame() {
    if (!match || !game) return;
    const lockedInPickBans = await lockInPositionalPicks();
    if (match.state !== "DRAFT_COMPLETE" && !draftFullyResolved(lockedInPickBans)) {
      setError("Can't save the draft yet — not all 10 players have a hero assigned.");
      return;
    }
    if (!confirm("Save this draft and start the game? This posts the draft recap to Telegram/Slack and moves the match to Game ongoing.")) return;
    await syncDraftHeroesToStats(lockedInPickBans);
    await postToTelegram(
      `📋 <b>Draft complete — Game ${game.game_number}</b>\n<b>${seriesScoreLine()}</b>\n${match.tournament?.name}\n\n${buildDraftRecap()}`,
      { entityType: "game", entityId: game.id, notificationType: "draft_result" }
    );
    await setMatchPhase("GAME_STARTED");
  }

  // Takes an optional explicit pickBans list instead of always reading
  // component state — needed right after lockInPositionalPicks(), whose
  // supabase writes land before the setPickBans state update actually
  // commits (React state, not a synchronous mutation), so checking this
  // immediately afterward against the stale `pickBans` closure would
  // still see the pre-lock-in (unresolved) picks.
  function draftFullyResolved(pickBansOverride?: PickBan[]): boolean {
    const list = pickBansOverride ?? pickBans;
    if (!match?.team_a || !match?.team_b) return false;
    for (const teamId of [match.team_a.id, match.team_b.id]) {
      // is_active_roster, not raw team_id membership — a team can carry
      // more than 5 rows (bench/subs), and without this filter a stray
      // extra player can land in the role-ordered top 5 instead of one of
      // the admin's actual designated starters (see toggleActiveRoster).
      const teamPlayers = players.filter((p) => p.team_id === teamId && p.is_active_roster).sort((a, b) => roleIndex(a.role) - roleIndex(b.role)).slice(0, 5);
      if (teamPlayers.length < 5) return false;
      if (teamPlayers.some((p) => !list.some((pb) => pb.player_id === p.id && pb.type === "pick"))) return false;
    }
    return true;
  }

  // Dumps everything currently on this page in one message — score so far,
  // this game's draft, KDA, and moment list — for whenever the admin wants
  // to share an update that doesn't fit one of the automatic triggers.
  async function shareFullMatchInfo() {
    if (!match || !game) return;
    const winsFor = (id: string) =>
      pastGames.filter((g) => g.winner_team_id === id).length + (game.winner_team_id === id ? 1 : 0);
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;

    // effectivePlayers so a custom player (player_id null, custom_player_name
    // set instead) still resolves to a name/team here — see buildLiveScoreboardMessage.
    const ownerOf = (s: PlayerStat) =>
      s.player_id ? effectivePlayers.find((p) => p.id === s.player_id) : effectivePlayers.find((p) => p.ign === s.custom_player_name);
    const kdaLines = [match.team_a, match.team_b]
      .map((team) => {
        if (!team) return "";
        const lines = stats
          .filter((s) => ownerOf(s)?.team_id === team.id)
          .map((s) => {
            const p = ownerOf(s);
            return `${p?.ign ?? "?"} (${s.hero_name ?? "?"}): ${s.kills}/${s.deaths}/${s.assists}`;
          })
          .join("\n");
        return lines ? `<b>${team.name}</b>\n${lines}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    const momentLines = keyMoments
      .map((km) => `${km.minute_mark}' ${km.description ?? km.type.replace(/_/g, " ")}`)
      .join("\n");

    const parts = [
      `📊 <b>Match update — Game ${game.game_number}</b>`,
      `${match.team_a?.name} ${aWins} – ${bWins} ${match.team_b?.name}\n${match.tournament?.name}`,
      buildDraftRecap(),
      kdaLines,
      momentLines ? `<b>Moments</b>\n${momentLines}` : "",
    ].filter(Boolean);

    await postToTelegram(parts.join("\n\n"), {
      entityType: "match",
      entityId: match.id,
      notificationType: "manual_share",
    });
  }

  // ── Hero picks/bans ─────────────────────────────────────────────────
  // player_id is required for picks (so the console can show who's
  // actually playing this game, not the whole roster) and left null for
  // bans, which are team-level decisions rather than one player's.
  // Shared by both the draft board's write paths and the OCR/AI-vision
  // draft-detection push flow (commitDraftAction below) — every pick/ban,
  // however it got logged, should show up in the Moment list without a
  // separate manual step.
  async function logPickBanMoment(type: "pick" | "ban", teamId: string, heroName: string, playerId?: string | null) {
    if (!game || !match) return;
    const teamName = teamId === match.team_a?.id ? match.team_a?.name : teamId === match.team_b?.id ? match.team_b?.name : "";
    const playerName = playerId ? players.find((p) => p.id === playerId)?.ign : null;
    const payload = {
      game_id: game.id,
      match_id: matchId,
      type,
      team_id: teamId,
      player_id: playerId || null,
      description: `${teamName} ${type === "pick" ? "picks" : "bans"} ${heroName}${playerName ? ` — ${playerName}` : ""}`,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "auto",
    };
    if (isContributor) {
      pushPendingEdit({ table: "key_moments", action: "insert", before: null, after: payload });
      return;
    }
    const { error } = await supabase.from("key_moments").insert(payload);
    if (error) setError(`Failed to log ${type} to the moment list: ${error.message}`);
  }

  // Add a brand-new pick, targeted at one exact player — the write behind
  // clicking an empty player slot on the draft board. Deliberately not the
  // "assign an already-logged, player-less pick" flow (that's
  // assignHeroToPlayer, used by the post-simulation assignment section
  // below) — this always inserts a fresh row, so it errors on a hero this
  // team already has rather than silently double-logging it.
  async function addPickForPlayer(teamId: string, playerId: string, heroName: string) {
    if (!game) return;
    const dupeHero = pickBans.some(
      (pb) => pb.team_id === teamId && pb.type === "pick" && pb.hero_name.toLowerCase() === heroName.toLowerCase()
    );
    if (dupeHero) {
      setError(`${heroName} is already picked by this team this game — if it just hasn't been assigned to a player yet, use the assignment list below instead.`);
      return;
    }
    const payload = {
      game_id: game.id,
      match_id: matchId,
      team_id: teamId,
      player_id: playerId,
      hero_name: heroName,
      hero_id: heroes.find((h) => h.name === heroName)?.id ?? null,
      type: "pick" as const,
      pick_order: pickBans.length + 1,
      custom_player_name: null as string | null,
      custom_player_role: null as string | null,
    };
    if (isContributor) {
      const newRow = { id: fakeId(), ...payload };
      pushPendingEdit({ table: "hero_picks_bans", action: "insert", before: null, after: newRow });
      setPickBans((prev) => [...prev, newRow as PickBan]);
      await logPickBanMoment("pick", teamId, heroName, playerId);
      await updateStat(playerId, "hero_name", heroName);
      return;
    }
    const { error } = await supabase.from("hero_picks_bans").insert(payload);
    if (error) {
      setError(error.message);
      return;
    }
    await logPickBanMoment("pick", teamId, heroName, playerId);
    // A manual pick is the scoreboard's source of truth for that slot —
    // sync it immediately instead of leaving the two to drift until
    // someone edits K/D/A by hand.
    await updateStat(playerId, "hero_name", heroName);
    loadAll();
  }
  // Add a brand-new ban for a team — the write behind clicking an empty ban
  // slot on the draft board. Same insert shape as addPickForPlayer, minus a
  // player.
  async function addBanForTeam(teamId: string, heroName: string) {
    if (!game) return;
    const dupeHero = pickBans.some(
      (pb) => pb.team_id === teamId && pb.type === "ban" && pb.hero_name.toLowerCase() === heroName.toLowerCase()
    );
    if (dupeHero) {
      setError(`${heroName} is already banned by this team this game.`);
      return;
    }
    const payload = {
      game_id: game.id,
      match_id: matchId,
      team_id: teamId,
      player_id: null as string | null,
      hero_name: heroName,
      hero_id: heroes.find((h) => h.name === heroName)?.id ?? null,
      type: "ban" as const,
      pick_order: pickBans.length + 1,
      custom_player_name: null as string | null,
      custom_player_role: null as string | null,
    };
    if (isContributor) {
      const newRow = { id: fakeId(), ...payload };
      pushPendingEdit({ table: "hero_picks_bans", action: "insert", before: null, after: newRow });
      setPickBans((prev) => [...prev, newRow as PickBan]);
      await logPickBanMoment("ban", teamId, heroName, null);
      return;
    }
    const { error } = await supabase.from("hero_picks_bans").insert(payload);
    if (error) {
      setError(error.message);
      return;
    }
    await logPickBanMoment("ban", teamId, heroName, null);
    loadAll();
  }
  async function deletePickBan(id: string) {
    if (isContributor) {
      const before = pickBans.find((p) => p.id === id) ?? null;
      pushPendingEdit({ table: "hero_picks_bans", action: "delete", before: before as unknown as Record<string, unknown> | null, after: null });
      setPickBans((prev) => prev.filter((p) => p.id !== id));
      return;
    }
    const { error } = await supabase.from("hero_picks_bans").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }
  // Corrects which hero a single already-logged pick/ban row was for — the
  // write path the draft board's click-a-slot correction flow uses (via
  // assignOrSwapHero below, which wraps this with the auto-swap check).
  // Same table, same update semantics as assignHeroToPlayer already uses
  // for the post-draft player assignment step — just correcting hero_name
  // instead of player_id.
  async function correctPickBanHero(pb: PickBan, heroName: string) {
    const heroId = heroes.find((h) => h.name === heroName)?.id ?? null;
    if (isContributor) {
      pushPendingEdit({
        table: "hero_picks_bans",
        action: "update",
        before: { id: pb.id, hero_name: pb.hero_name },
        after: { id: pb.id, hero_name: heroName, hero_id: heroId },
      });
      setPickBans((prev) => prev.map((p) => (p.id === pb.id ? { ...p, hero_name: heroName } : p)));
      if (pb.type === "pick" && pb.player_id) await updateStat(pb.player_id, "hero_name", heroName);
      return;
    }
    const { error } = await supabase.from("hero_picks_bans").update({ hero_name: heroName, hero_id: heroId }).eq("id", pb.id);
    if (error) {
      setError(error.message);
      return;
    }
    if (pb.type === "pick" && pb.player_id) await updateStat(pb.player_id, "hero_name", heroName);
    loadAll();
  }

  // Correcting a pick's hero to one a teammate already has swaps the two
  // instead of erroring or leaving a duplicate — replaces the old
  // standalone drag-and-drop swap grid with the same click-to-correct flow
  // used for a plain mistake. Bans never conflict this way (no per-player
  // slot to steal from), so they always go through the plain correction.
  async function assignOrSwapHero(pb: PickBan, heroName: string) {
    if (pb.type === "pick") {
      const conflicting = pickBans.find(
        (other) => other.id !== pb.id && other.team_id === pb.team_id && other.type === "pick" && other.hero_name.toLowerCase() === heroName.toLowerCase()
      );
      if (conflicting) {
        const previousHero = pb.hero_name;
        await correctPickBanHero(pb, heroName);
        await correctPickBanHero(conflicting, previousHero);
        return;
      }
    }
    await correctPickBanHero(pb, heroName);
  }

  // ── Scoreboard ──────────────────────────────────────────────────────
  // A match-local custom player (added in Hero picks & bans — see
  // addCustomPlayerToPick below) has no `players` row, so nothing here can
  // key off a real player_id for them. Every call-site that takes a
  // "playerId" string instead accepts this synthetic id — `custom:<pick-
  // ban row id>` — so the rest of the scoreboard code (KDA inputs, hero
  // picker, etc.) doesn't need two parallel sets of handlers, just this one
  // branch point. The pick-ban row's own custom_player_name is the actual
  // identity; the row id is only there to keep the synthetic id unique and
  // traceable back to which pick it came from.
  function isCustomPlayerId(id: string): boolean {
    return id.startsWith("custom:");
  }
  function customPlayerNameFor(id: string): string | null {
    const pbId = id.slice("custom:".length);
    return pickBans.find((pb) => pb.id === pbId)?.custom_player_name ?? null;
  }
  async function ensureStatRow(playerId: string) {
    if (isCustomPlayerId(playerId)) {
      const name = customPlayerNameFor(playerId);
      if (!name || !game) return undefined;
      const existing = stats.find((s) => s.custom_player_name === name);
      if (existing) return existing;
      // onConflict targets the partial unique index on (game_id,
      // custom_player_name) added alongside this column — same
      // "insert-or-return-existing" shape as a real player's row below,
      // just keyed by name instead of player_id since there's no players
      // row to key off.
      const { data } = await supabase
        .from("player_stats")
        .upsert(
          { game_id: game.id, match_id: matchId, player_id: null, custom_player_name: name, kills: null, deaths: null, assists: null },
          { onConflict: "game_id,custom_player_name" }
        )
        .select("id, player_id, hero_name, kills, deaths, assists, gold, custom_player_name")
        .single();
      if (data) setStats((prev) => [...prev, data as PlayerStat]);
      return data as PlayerStat | undefined;
    }
    const existing = stats.find((s) => s.player_id === playerId);
    if (existing || !game) return existing;
    if (isContributor) {
      const newRow: PlayerStat = { id: fakeId(), player_id: playerId, hero_name: null, kills: null, deaths: null, assists: null, gold: 0, custom_player_name: null };
      pushPendingEdit({
        table: "player_stats",
        action: "insert",
        before: null,
        after: { game_id: game.id, match_id: matchId, player_id: playerId, kills: null, deaths: null, assists: null } as unknown as Record<string, unknown>,
      });
      setStats((prev) => [...prev, newRow]);
      return newRow;
    }
    // Explicit nulls, not the table's own default-0 — a freshly-created row
    // (e.g. from syncing a draft pick's hero) should read TBD until kills/
    // deaths/assists actually get set, not silently show "0" for a stat
    // nobody's entered yet. match_id is required too — the public match
    // page's player_stats query filters on it (as does its realtime
    // subscription), so a row missing it was invisible there forever, not
    // just delayed, even though the admin console itself never noticed
    // since its own query only filters on game_id.
    const { data } = await supabase
      .from("player_stats")
      .insert({ game_id: game.id, match_id: matchId, player_id: playerId, kills: null, deaths: null, assists: null })
      .select("id, player_id, hero_name, kills, deaths, assists, gold, custom_player_name")
      .single();
    if (data) setStats((prev) => [...prev, data as PlayerStat]);
    return data as PlayerStat | undefined;
  }
  async function updateStat(playerId: string, field: keyof PlayerStat, value: number | string) {
    const custom = isCustomPlayerId(playerId);
    let row = custom
      ? stats.find((s) => s.custom_player_name === customPlayerNameFor(playerId))
      : stats.find((s) => s.player_id === playerId);
    if (!row) row = await ensureStatRow(playerId);
    if (!row) return;
    const payload: Record<string, number | string | null> = { [field]: value };
    if (field === "hero_name") payload.hero_id = matchHeroId(value as string);
    if (isContributor && !custom) {
      pushPendingEdit({ table: "player_stats", action: "update", before: { id: row.id }, after: { id: row.id, ...payload } });
      setStats((prev) => prev.map((s) => (s.id === row!.id ? { ...s, [field]: value } : s)));
      return;
    }
    await supabase.from("player_stats").update(payload).eq("id", row.id);
    loadAll();
  }

  // ── Live scoreboard: edit/delete player directly ─────────────────────
  // The roster shown here often surfaces real data-quality problems (a
  // nationality mistakenly imported as a player, a stale/duplicate row) —
  // fixing that shouldn't require leaving this page for /admin/players.
  const [editingScoreboardPlayerId, setEditingScoreboardPlayerId] = useState<string | null>(null);
  const [editingScoreboardIgn, setEditingScoreboardIgn] = useState("");
  // Keyed by team_id — which roster player is selected in that team's
  // "add player" dropdown (for a substitute the scoreboard didn't already
  // pick up automatically).
  const [addPlayerSelect, setAddPlayerSelect] = useState<Record<string, string>>({});
  // Pop-out hero picker — all hero icons/names at a glance for fast
  // pick/ban selection, since scrolling a plain <select> of 130+ heroes by
  // name is slow mid-draft. This is now the ONLY place a hero gets chosen —
  // every click on the draft board (correct a filled slot, add a pick to an
  // empty player slot, add a ban to an empty ban slot) opens this same
  // modal, just targeted differently via heroPickerTarget. Reference-only
  // browsing (the "Hero reference" button) opens it with target null.
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  type HeroPickerTarget =
    | { mode: "correct"; pb: PickBan; label: string }
    | { mode: "add-pick"; teamId: string; playerId: string; label: string }
    | { mode: "add-ban"; teamId: string; label: string };
  const [heroPickerTarget, setHeroPickerTarget] = useState<HeroPickerTarget | null>(null);

  // Swap-which-player-a-hero-is-credited-to — replaces the old post-draft
  // "Assign player" dropdown screen. First ⇄ click on the draft board
  // records the source; a second ⇄ click on a *different* player commits
  // the swap (see swapPlayerAssignment); clicking the same player again
  // cancels. Both players' picks get real player_id rows either way, even
  // if one or both started out only positionally matched (see
  // DraftOverlay's file comment) — a swap is what turns a positional guess
  // into a confirmed assignment.
  const [swapSource, setSwapSource] = useState<{ playerId: string; pb: DraftOverlayPickBan } | null>(null);
  function handleSwapClick(player: DraftOverlayPlayer, pb: DraftOverlayPickBan) {
    if (!swapSource) {
      setSwapSource({ playerId: player.id, pb });
      return;
    }
    if (swapSource.playerId === player.id) {
      setSwapSource(null);
      return;
    }
    if (swapSource.pb.team_id !== pb.team_id) {
      setError("Can only swap between two players on the same team.");
      setSwapSource(null);
      return;
    }
    swapPlayerAssignment(swapSource.pb, swapSource.playerId, pb, player.id);
    setSwapSource(null);
  }
  async function swapPlayerAssignment(pbA: DraftOverlayPickBan, playerAId: string, pbB: DraftOverlayPickBan, playerBId: string) {
    const realA = pickBans.find((p) => p.id === pbA.id);
    const realB = pickBans.find((p) => p.id === pbB.id);
    if (!realA || !realB) return;
    await assignHeroToPlayer(realA.id, playerBId, realA.hero_name);
    await assignHeroToPlayer(realB.id, playerAId, realB.hero_name);
  }

  function closeHeroPicker() {
    setShowHeroPicker(false);
    setHeroPickerTarget(null);
  }
  // Single dispatch point for every DraftOverlay slot click — opens the
  // shared hero picker already targeted at the right write (correct/add
  // pick/add ban). See DraftOverlaySlotAction for the shape this handles.
  function handleDraftSlotClick(action: DraftOverlaySlotAction) {
    if (action.mode === "correct") {
      const realPb = pickBans.find((p) => p.id === action.pb.id);
      if (!realPb) return;
      setHeroPickerTarget({ mode: "correct", pb: realPb, label: action.label });
    } else if (action.mode === "add-pick") {
      setHeroPickerTarget({ mode: "add-pick", teamId: action.teamId, playerId: action.playerId, label: action.label });
    } else {
      setHeroPickerTarget({ mode: "add-ban", teamId: action.teamId, label: action.label });
    }
    setShowHeroPicker(true);
  }
  // Reconciles this Hot match's hero picks/bans against Liquipedia's own
  // bracket record — see scripts/sync-hot-match-picks-bans.mjs for why this
  // only ever touches which hero was picked/banned, never kill stats, the
  // moment list, or match/game state.
  const [syncingDraft, setSyncingDraft] = useState(false);
  const [syncDraftStatus, setSyncDraftStatus] = useState("");
  const [editingFinishedGame, setEditingFinishedGame] = useState(false);
  useEffect(() => {
    setEditingFinishedGame(false);
  }, [game?.id]);
  async function saveScoreboardPlayerEdit(playerId: string) {
    if (!editingScoreboardIgn.trim() || isContributor) return;
    const newName = editingScoreboardIgn.trim();
    // A custom player has no `players` row to update — the pick-ban row's
    // custom_player_name is the identity, and any existing player_stats
    // row is keyed off that same name (see the partial unique index), so
    // both need the rename or the KDA row silently orphans under the old
    // name.
    if (isCustomPlayerId(playerId)) {
      const pbId = playerId.slice("custom:".length);
      const oldName = pickBans.find((row) => row.id === pbId)?.custom_player_name ?? null;
      const { error } = await supabase.from("hero_picks_bans").update({ custom_player_name: newName }).eq("id", pbId);
      if (error) {
        setError(error.message);
        return;
      }
      if (oldName) await supabase.from("player_stats").update({ custom_player_name: newName }).eq("custom_player_name", oldName).is("player_id", null);
      setEditingScoreboardPlayerId(null);
      loadAll();
      return;
    }
    const { error } = await supabase.from("players").update({ ign: newName }).eq("id", playerId);
    if (error) setError(error.message);
    else {
      setEditingScoreboardPlayerId(null);
      loadAll();
    }
  }
  async function deleteScoreboardPlayer(playerId: string, ign: string) {
    if (isContributor) return;
    // Custom players were never a `players` row — "deleting" them just
    // clears the custom name/role off their pick-ban row (reverting it to
    // unassigned, same as any other pick that hasn't had a player
    // assigned yet) and drops their KDA row, rather than a real DELETE
    // against the players table.
    if (isCustomPlayerId(playerId)) {
      if (!confirm(`Remove custom player "${ign}" from this match? Their K/D/A entry for this game will be deleted too.`)) return;
      const pbId = playerId.slice("custom:".length);
      const customName = pickBans.find((row) => row.id === pbId)?.custom_player_name ?? null;
      await supabase.from("hero_picks_bans").update({ custom_player_name: null, custom_player_role: null }).eq("id", pbId);
      if (customName) await supabase.from("player_stats").delete().eq("custom_player_name", customName).is("player_id", null);
      loadAll();
      return;
    }
    if (!confirm(`Delete player "${ign}"? This can't be undone.`)) return;
    const { error } = await supabase.from("players").delete().eq("id", playerId);
    if (error) {
      setError(
        error.message.includes("violates foreign key")
          ? `Can't delete "${ign}" — still referenced by pick/ban or stat rows in another match.`
          : error.message
      );
      return;
    }
    loadAll();
  }
  function buildLiveScoreboardMessage(): string {
    // effectivePlayers (players + synthetic custom-player rows, see
    // activeFive above) instead of raw `players` — otherwise a custom
    // player's stat row (player_id null, custom_player_name set) never
    // resolves to a name here and just shows as "?".
    const lookup = (s: PlayerStat) =>
      s.player_id ? effectivePlayers.find((p) => p.id === s.player_id) : effectivePlayers.find((p) => p.ign === s.custom_player_name);
    const lines = [match?.team_a, match?.team_b].map((team) => {
      if (!team) return "";
      const teamStats = stats.filter((s) => lookup(s)?.team_id === team.id);
      const rows = teamStats
        .map((s) => `${lookup(s)?.ign ?? "?"} (${s.hero_name ?? "?"}): ${s.kills}/${s.deaths}/${s.assists}`)
        .join("\n");
      return rows ? `<b>${team.name}</b>\n${rows}` : "";
    });
    return [`📊 <b>Live scoreboard</b>`, `${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`, ...lines.filter(Boolean)].join("\n\n");
  }

  // ── Objectives (counters) ────────────────────────────────────────────
  // Stays an event-log table under the hood (one row per tower/lord/turtle
  // taken) — a counter UI is just "+" inserts a row, "−" removes the most
  // recently inserted row of that type/team, so the displayed number is
  // always just objectives.filter(...).length.
  const OBJECTIVE_TYPES = ["tower", "lord", "turtle"] as const;
  // Left-to-right (or top-to-bottom — whatever order the icon cluster
  // reads in) icon order for the "objectives_group" combined tracker, per
  // side. MLBB broadcasts consistently show a team's tower/lord/turtle
  // icons as one fixed-order cluster, but which order — and most
  // tournaments mirror the right team's panel around the center of the
  // HUD, so its reading order is usually the reverse of the left team's —
  // isn't the same across every broadcast overlay. This is a starting
  // guess (tower→lord→turtle scanning left-to-right for the left panel,
  // reversed for the mirrored right one), not a hardcoded certainty; it's
  // exactly as adjustable as any other tracker box; if a broadcast doesn't
  // match this order, calibrate the box tighter or fall back to the 3
  // individual per-type trackers instead.
  const OBJECTIVE_GROUP_ORDER: Record<Side, (typeof OBJECTIVE_TYPES)[number][]> = {
    left: ["tower", "lord", "turtle"],
    right: ["turtle", "lord", "tower"],
  };
  function objectiveCount(teamId: string, type: string) {
    return objectives.filter((o) => o.team_id === teamId && o.type === type).length;
  }
  // Turtle/Lord spawn-timing gates (plausibleObjectiveTarget below) reason
  // about the objective globally — "at most 4 turtles total this match",
  // "the next Lord can't spawn less than 3 minutes after the last one
  // died" — neither team-scoped, so these read across both teams' rows.
  function totalObjectiveCount(type: string) {
    return objectives.filter((o) => o.type === type).length;
  }
  function lastObjectiveSeconds(type: string): number | null {
    const rows = objectives.filter((o) => o.type === type);
    if (rows.length === 0) return null;
    return Math.max(...rows.map((o) => (o.minute_mark ?? 0) * 60));
  }
  // An admin's manual count correction (the direct-input field, or the
  // +/- buttons) used to get silently clobbered on the very next OCR tick:
  // the on-screen count hadn't changed, so plausibleObjectiveTarget just
  // read the same higher number and pushed the count right back up,
  // making a manual "fix" feel like it never took. Player KDA doesn't
  // have this problem because it never auto-decreases (Math.max against
  // stored values) — but this is the opposite direction (an admin
  // correcting DOWN, then OCR reading the old, unchanged on-screen number
  // and going back UP), so the same clamp doesn't apply here. Instead,
  // give a manual edit a short window where a conflicting OCR read is
  // held back as a flagged/pending suggestion (same "candidate, don't
  // auto-commit" pattern used elsewhere) rather than auto-applied —
  // matching the validation spec's "prefer the last confirmed value over
  // a fresh but suspicious OCR result."
  const MANUAL_OBJECTIVE_COOLDOWN_MS = 30_000;
  const manualObjectiveEditRef = useRef<Record<string, number>>({});
  function markManualObjectiveEdit(teamId: string, type: string) {
    manualObjectiveEditRef.current[`${teamId}:${type}`] = Date.now();
  }
  function withinManualObjectiveCooldown(teamId: string, type: string): boolean {
    const at = manualObjectiveEditRef.current[`${teamId}:${type}`];
    return at != null && Date.now() - at < MANUAL_OBJECTIVE_COOLDOWN_MS;
  }
  function buildObjectivesMessage(): string {
    const lines = [match?.team_a, match?.team_b].map((team) => {
      if (!team) return "";
      const counts = OBJECTIVE_TYPES.map((type) => `${type}: ${objectiveCount(team.id, type)}`).join(" · ");
      return `<b>${team.name}</b>\n${counts}`;
    });
    return [`🏰 <b>Objectives</b>`, `${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`, ...lines.filter(Boolean)].join("\n\n");
  }
  const OBJECTIVE_ICONS: Record<string, string> = { tower: "🗼", lord: "👑", turtle: "🐢" };
  // Surfaced in the button/input tooltips below — the actual timing/cap
  // guards live in plausibleObjectiveTarget, this is just putting the same
  // rules in front of the admin instead of leaving them invisible until an
  // OCR read gets silently held back. A manual click/edit still always
  // goes through (see incrementObjective/setObjectiveCount, which never
  // gate the admin the way OCR reads do) — these are what OCR is allowed
  // to auto-apply, not a hard limit on the admin's own count.
  const OBJECTIVE_RULE_HINTS: Record<string, string> = {
    tower: "Max 9 per team. OCR won't jump the count by more than 3 in one tick (a bigger jump is treated as a misread, not 4+ towers falling at once).",
    lord: "First spawns ~08:00. Respawns exactly 3:00 after being slain — OCR won't count another kill sooner than that.",
    turtle: "Max 4 per match (shared, not per side). First spawns ~02:00. No further turtle after ~06:00 since the last one — it becomes an early Lord instead.",
  };
  async function incrementObjective(teamId: string, type: string) {
    if (!game || !match) return;
    // A one-click objective button is otherwise silent on the public Moment
    // list — it only ever showed up in the Objectives tab's running count.
    // "objective" isn't one of key_moments_type_check's allowed values —
    // "custom" (already used for other manual admin-logged entries, e.g.
    // net worth corrections) is, and the Moment list already renders
    // `description` regardless of type.
    const teamName = teamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
    const momentPayload = {
      game_id: game.id,
      match_id: matchId,
      type: "custom",
      team_id: teamId,
      description: `${teamName} takes ${OBJECTIVE_ICONS[type] ?? ""} ${type}`,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "manual",
    };
    if (isContributor) {
      const newRow: Objective = { id: fakeId(), team_id: teamId, type, minute_mark: minute, created_at: new Date().toISOString() };
      pushPendingEdit({
        table: "objectives",
        action: "insert",
        before: null,
        after: { game_id: game.id, match_id: matchId, team_id: teamId, type, minute_mark: minute },
      });
      setObjectives((prev) => [...prev, newRow]);
      pushPendingEdit({ table: "key_moments", action: "insert", before: null, after: momentPayload });
      return;
    }
    const { data: insertedObjective } = await supabase
      .from("objectives")
      .insert({ game_id: game.id, match_id: matchId, team_id: teamId, type, minute_mark: minute })
      .select("id")
      .single();
    await supabase.from("key_moments").insert(momentPayload);
    if (insertedObjective) setLastAction({ table: "objectives", id: insertedObjective.id, label: momentPayload.description, kind: "insert" });
    loadAll();
  }
  async function decrementObjective(teamId: string, type: string) {
    // Only ever called manually (right-click undo, or setObjectiveCount's
    // own direct-input path) — OCR-driven reads only ever increment, so
    // this is always a real correction worth protecting from getting
    // immediately undone by the next tick. See markManualObjectiveEdit.
    markManualObjectiveEdit(teamId, type);
    const mostRecent = objectives
      .filter((o) => o.team_id === teamId && o.type === type)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!mostRecent) return;
    if (isContributor) {
      pushPendingEdit({ table: "objectives", action: "delete", before: mostRecent as unknown as Record<string, unknown>, after: null });
      setObjectives((prev) => prev.filter((o) => o.id !== mostRecent.id));
      return;
    }
    const { error } = await supabase.from("objectives").delete().eq("id", mostRecent.id);
    if (error) setError(error.message);
    else loadAll();
  }
  async function deleteObjective(objectiveId: string) {
    if (isContributor) {
      const obj = objectives.find((o) => o.id === objectiveId);
      if (obj) {
        pushPendingEdit({ table: "objectives", action: "delete", before: obj as unknown as Record<string, unknown>, after: null });
        setObjectives((prev) => prev.filter((o) => o.id !== objectiveId));
      }
      return;
    }
    const { error } = await supabase.from("objectives").delete().eq("id", objectiveId);
    if (error) setError(error.message);
    else loadAll();
  }

  // ── Net worth (OCR-fed, but directly editable) ───────────────────────
  // "Latest" is just the highest minute_mark row for this game — snapshots
  // are ordered ascending by loadAll's query.
  const latestNetWorth = netWorth[netWorth.length - 1] ?? null;
  async function updateNetWorthManual(teamAGold: number, teamBGold: number) {
    if (!game || !match) return;
    const snapshotPayload = { game_id: game.id, match_id: matchId, minute_mark: minute, team_a_gold: teamAGold, team_b_gold: teamBGold };
    // Every manual edit gets logged — net worth otherwise only ever moves
    // via silent OCR ticks, so a manual correction should be visible/
    // auditable in the same moment list everything else goes through.
    const momentPayload = {
      game_id: game.id,
      match_id: matchId,
      type: "custom",
      description: `Net worth manually set — ${match.team_a?.name}: ${teamAGold.toLocaleString()}, ${match.team_b?.name}: ${teamBGold.toLocaleString()}`,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "manual",
    };
    if (isContributor) {
      pushPendingEdit({ table: "net_worth_snapshots", action: "insert", before: null, after: snapshotPayload });
      setNetWorth((prev) => [...prev, { minute_mark: minute, team_a_gold: teamAGold, team_b_gold: teamBGold }]);
      pushPendingEdit({ table: "key_moments", action: "insert", before: null, after: momentPayload });
      return;
    }
    await supabase.from("net_worth_snapshots").insert(snapshotPayload);
    await supabase.from("key_moments").insert(momentPayload);
    loadAll();
  }

  // ── Key moments (template-driven) ────────────────────────────────────
  // Replaces free-typed moment logging with admin-managed prefilled
  // templates (/admin/moment-templates) — "Team {team} picks {hero}"
  // style placeholders get resolved from this match's own roster/hero
  // data rather than retyped by hand every time.
  const [momentTemplates, setMomentTemplates] = useState<MomentTemplate[]>([]);
  const [kmTemplateId, setKmTemplateId] = useState("");
  const [kmTeam, setKmTeam] = useState("");
  const [kmHero, setKmHero] = useState("");
  const [kmPlayer, setKmPlayer] = useState("");
  const [kmAttachScreenshot, setKmAttachScreenshot] = useState(false);
  const [kmCustomText, setKmCustomText] = useState("");
  const [kmMarkAsKey, setKmMarkAsKey] = useState(false);
  const [editingMomentId, setEditingMomentId] = useState<string | null>(null);
  const [editingMomentText, setEditingMomentText] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("moment_templates")
        .select("id, type, label_template, phase, telegram_enabled, telegram_message_template")
        .order("sort_order");
      setMomentTemplates((data as MomentTemplate[]) ?? []);
    })();
  }, []);

  // "phase_notice" rows are Telegram config only (see /admin/moment-templates)
  // — a phase transition, not something the admin picks from this dropdown.
  const availableTemplates = momentTemplates.filter((t) => t.type !== "phase_notice" && (!t.phase || t.phase === match?.state));
  // Free-typed moments used to depend on some admin having pre-created a
  // "custom"-typed row on /admin/moment-templates for this phase —
  // otherwise the option never appeared in the dropdown at all, and
  // "Log a moment" had no way to log anything that wasn't a template.
  // This sentinel makes a genuinely custom entry always available, no
  // setup required — logKeyMoment already knows what to do with
  // type "custom" (see its kmCustomText branch), this just constructs
  // that template object on the fly instead of requiring one in the DB.
  const CUSTOM_TEMPLATE_ID = "__custom__";
  const CUSTOM_TEMPLATE: MomentTemplate = {
    id: CUSTOM_TEMPLATE_ID,
    type: "custom",
    label_template: "Custom moment...",
    phase: null,
    telegram_enabled: false,
    telegram_message_template: null,
  };
  const selectedTemplate =
    kmTemplateId === CUSTOM_TEMPLATE_ID ? CUSTOM_TEMPLATE : momentTemplates.find((t) => t.id === kmTemplateId) ?? null;

  // Shared {placeholder} substitution for both moment-log and phase-notice
  // Telegram messages — {team}/{hero}/{player} match the moment_templates
  // convention already documented on /admin/moment-templates.
  function fillTelegramTemplate(tpl: string, vars: Record<string, string>) {
    return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v ?? ""), tpl);
  }

  // declareGameWinner/finalizeSeriesFinished used to post a hardcoded
  // Telegram string for "game_finish"/"match_finish" no matter what an
  // admin configured on /admin/telegram-notifications (unlike the
  // DRAFT_STARTED/DRAFT_COMPLETE/GAME_STARTED phase notices below, which
  // already respect their moment_templates row) — editing that template
  // had zero effect. Same lookup pattern as those phase notices: an
  // existing row's telegram_enabled/telegram_message_template wins, no row
  // at all preserves the old always-on default so existing setups don't
  // suddenly go silent.
  function telegramMessageFor(type: string, defaultMessage: string, vars: Record<string, string>) {
    const tpl = momentTemplates.find((t) => t.type === type && !t.phase);
    if (!tpl) return defaultMessage;
    if (!tpl.telegram_enabled) return null;
    return tpl.telegram_message_template ? fillTelegramTemplate(tpl.telegram_message_template, vars) : defaultMessage;
  }

  // These auto/manual key-moment screenshots get shared around directly
  // (viewers screenshot Savage/Maniac clips constantly) with no indication
  // they came from this broadcast's own capture — stamp a small logo +
  // "Captured with Livevival" credit onto the bottom of the frame before
  // upload. Logo is cached after the first load since every capture reuses it.
  const watermarkLogoRef = useRef<HTMLImageElement | null>(null);
  function loadWatermarkLogo(): Promise<HTMLImageElement | null> {
    if (watermarkLogoRef.current) return Promise.resolve(watermarkLogoRef.current);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        watermarkLogoRef.current = img;
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = "/logo/logo-dark-bg.png";
    });
  }
  async function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const logo = await loadWatermarkLogo();
    const pad = Math.max(12, width * 0.015);
    const logoWidth = logo ? Math.min(width * 0.2, 200) : 0;
    const logoHeight = logo ? logoWidth * (logo.naturalHeight / logo.naturalWidth) : 0;

    // Right side stacks two lines instead of one: which match/tournament
    // this frame came from (so a screenshot still identifies itself once
    // it's been reposted elsewhere, stripped of any surrounding context),
    // above the existing "Captured with Livevival" credit. The bar grows
    // to fit whichever is taller — the logo, or this two-line text block.
    const captionSize = Math.max(11, Math.round(width * 0.014));
    const creditSize = Math.max(9, Math.round(width * 0.011));
    const lineGap = Math.max(2, Math.round(width * 0.003));
    const matchCaption =
      match?.team_a?.name && match?.team_b?.name ? `${match.team_a.name} vs ${match.team_b.name}` : null;
    const tournamentCaption = match?.tournament?.name ?? null;
    const textBlockHeight = matchCaption ? captionSize + creditSize + lineGap : creditSize;

    const barHeight = Math.max(logoHeight, textBlockHeight, 22) + pad;
    const centerY = height - barHeight / 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, height - barHeight, width, barHeight);
    if (logo) ctx.drawImage(logo, pad, height - logoHeight - pad / 2, logoWidth, logoHeight);

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    if (matchCaption) {
      ctx.font = `600 ${captionSize}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(
        tournamentCaption ? `${matchCaption} · ${tournamentCaption}` : matchCaption,
        width - pad,
        centerY - (creditSize + lineGap) / 2
      );
      ctx.font = `${creditSize}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText("Captured with Livevival", width - pad, centerY + (captionSize + lineGap) / 2);
    } else {
      ctx.font = `${creditSize}px sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText("Captured with Livevival", width - pad, centerY);
    }
  }

  // Captures the current shared-screen frame and uploads it straight into
  // the moment being logged (key_moments.screenshot_url) instead of a
  // separate game_screenshots row — one attach action, one moment, one
  // image, rather than two records that have to be manually cross-referenced.
  function captureFrameBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const video = previewRef.current;
      if (!video || video.videoWidth === 0) {
        resolve(null);
        return;
      }
      const canvas = cropVideoToEmbed(video, captureArea);
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        resolve(null);
        return;
      }
      drawWatermark(ctx, canvas.width, canvas.height).then(() => {
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
      });
    });
  }
  async function uploadMomentScreenshot(): Promise<string | null> {
    if (!game) return null;
    const blob = await captureFrameBlob();
    if (!blob) return null;
    const path = `${game.id}/${Date.now()}-moment.jpg`;
    const { error: uploadErr } = await supabase.storage.from("key-moment-screenshots").upload(path, blob, {
      contentType: "image/jpeg",
    });
    if (uploadErr) {
      setError(uploadErr.message);
      return null;
    }
    const { data: pub } = supabase.storage.from("key-moment-screenshots").getPublicUrl(path);
    return pub.publicUrl;
  }

  function resetKmForm() {
    setKmTeam("");
    setKmHero("");
    setKmPlayer("");
    setKmAttachScreenshot(false);
    setKmCustomText("");
    setKmMarkAsKey(false);
  }

  async function logKeyMoment() {
    if (!game || !selectedTemplate || !match) return;

    // "Team {team} wins the game!" / "wins the match!" describe a real
    // match-affecting event, not just log text — route through the same
    // winner-declare / series-finish logic used elsewhere (which also
    // updates games/matches rows, posts Telegram, and logs its own
    // moment) instead of writing a moment that claims something the
    // match's actual state doesn't reflect.
    if (selectedTemplate.type === "game_finish" && kmTeam) {
      await declareGameWinner(kmTeam);
      resetKmForm();
      return;
    }
    if (selectedTemplate.type === "match_finish" && kmTeam && (kmTeam === match.team_a?.id || kmTeam === match.team_b?.id)) {
      const allGames = [...pastGames, game];
      const winsFor = (id: string) => allGames.filter((g) => g.winner_team_id === id).length;
      const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
      const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
      const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
      const teamWins = kmTeam === match.team_a?.id ? aWins : bWins;
      if (teamWins < required) {
        setError(
          `Can't log "wins the match" yet — ${kmTeam === match.team_a?.id ? match.team_a?.name : match.team_b?.name} only has ${teamWins}/${required} game win(s) for ${match.format ?? "BO3"}.`
        );
        return;
      }
      await finalizeSeriesFinished(kmTeam, aWins, bWins);
      resetKmForm();
      return;
    }

    const teamName = kmTeam === match.team_a?.id ? match.team_a?.name : kmTeam === match.team_b?.id ? match.team_b?.name : "";
    const heroName = heroes.find((h) => h.id === kmHero)?.name ?? "";
    const playerName = players.find((p) => p.id === kmPlayer)?.ign ?? "";
    // "custom" is the one type meant for genuine free typing, not a fixed
    // prefilled string — everything else still comes from the template.
    const description =
      selectedTemplate.type === "custom" && kmCustomText.trim()
        ? kmCustomText.trim()
        : selectedTemplate.label_template
            .replace("{team}", teamName)
            .replace("{hero}", heroName)
            .replace("{player}", playerName)
            .replace("{timestamp}", mmssTimestamp());
    // Savage/maniac/etc. are always key moments; a custom entry can be
    // explicitly flagged as one too (e.g. an admin's own big-play call).
    const isKeyMoment = KEY_MOMENT_TYPES.includes(selectedTemplate.type) || (selectedTemplate.type === "custom" && kmMarkAsKey);
    // Savage/Maniac are the two moments worth an automatic screenshot —
    // no reason to make the admin remember to tick the checkbox for
    // exactly the plays viewers most want a picture of.
    const autoScreenshot = selectedTemplate.type === "savage" || selectedTemplate.type === "maniac";

    const screenshotUrl = (kmAttachScreenshot || autoScreenshot) && captureActive ? await uploadMomentScreenshot() : null;

    const { data: inserted, error: insertError } = await supabase
      .from("key_moments")
      .insert({
        game_id: game.id,
        match_id: matchId,
        type: selectedTemplate.type,
        description,
        player_id: kmPlayer || null,
        team_id: kmTeam || null,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
        is_key_moment: isKeyMoment,
        screenshot_url: screenshotUrl,
      })
      .select("id")
      .single();
    // Was previously unchecked — a rejected insert (e.g. a template type
    // the key_moments type CHECK constraint didn't allow) failed with no
    // feedback at all, which read as "the moment log button does nothing."
    if (insertError) {
      setError(insertError.message);
      return;
    }
    if (inserted) setLastAction({ table: "key_moments", id: inserted.id, label: description, kind: "insert" });
    // Securing Lord/Turtle is also an objective — logging the moment
    // shouldn't require a second trip to the Objectives counters below to
    // make the scoreboard agree with what the moment list just said.
    if ((selectedTemplate.type === "lord_steal" || selectedTemplate.type === "turtle_steal") && kmTeam) {
      await incrementObjective(kmTeam, selectedTemplate.type === "lord_steal" ? "lord" : "turtle");
    }
    // Whether this auto-shares to Telegram is config-driven per template
    // (/admin/moment-templates), not tied to is_key_moment — everything else
    // (picks, bans, phase changes not configured to auto-post) stays manual
    // via the 📢 button per moment.
    if (selectedTemplate.telegram_enabled) {
      const message = selectedTemplate.telegram_message_template
        ? fillTelegramTemplate(selectedTemplate.telegram_message_template, { team: teamName, hero: heroName, player: playerName, timestamp: mmssTimestamp() })
        : `🔥 <b>${description}</b>\n${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`;
      postToTelegram(
        message,
        { entityType: "key_moment", entityId: game.id, notificationType: "key_moment_auto" },
        screenshotUrl ?? undefined
      );
    }
    resetKmForm();
    loadAll();
  }
  async function deleteKeyMoment(id: string) {
    const { error } = await supabase.from("key_moments").delete().eq("id", id);
    if (error) setError(error.message);
    else loadAll();
  }
  async function updateKeyMoment(id: string, description: string) {
    const { error } = await supabase.from("key_moments").update({ description }).eq("id", id);
    if (error) setError(error.message);
    else {
      setEditingMomentId(null);
      loadAll();
    }
  }

  // ── Game screenshots ────────────────────────────────────────────────
  // Replaces the old per-player item-build text inputs: instead of the
  // admin transcribing item icons into free-text slots, they capture (or
  // upload) an actual screenshot of the in-game inventory/scoreboard,
  // stamped with both the in-game timer and the real capture time.
  const [screenshotUploading, setScreenshotUploading] = useState(false);
  const [screenshotNote, setScreenshotNote] = useState("");

  async function uploadScreenshot(blob: Blob, noteOverride?: string) {
    if (!game) return;
    setScreenshotUploading(true);
    try {
      const path = `${game.id}/${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage.from("key-moment-screenshots").upload(path, blob, {
        contentType: "image/jpeg",
      });
      if (uploadErr) {
        setError(uploadErr.message);
        return;
      }
      const { data: pub } = supabase.storage.from("key-moment-screenshots").getPublicUrl(path);
      const inGameTime = `${String(minute).padStart(2, "0")}:00`;
      const { error: insertErr } = await supabase.from("game_screenshots").insert({
        game_id: game.id,
        match_id: matchId,
        image_url: pub.publicUrl,
        in_game_time: inGameTime,
        note: noteOverride ?? screenshotNote ?? null,
      });
      if (insertErr) {
        setError(insertErr.message);
        return;
      }
      // Same treatment as every other auto Telegram notification — a
      // screenshot used to be an entirely separate system with no path to
      // the channel at all.
      postToTelegram(
        `📸 <b>Screenshot</b> — ${match?.team_a?.name} vs ${match?.team_b?.name}${noteOverride ?? screenshotNote ? `\n${noteOverride ?? screenshotNote}` : ""}`,
        { entityType: "game", entityId: game.id, notificationType: "screenshot" },
        pub.publicUrl
      );
      setScreenshotNote("");
      loadAll();
    } finally {
      setScreenshotUploading(false);
    }
  }

  async function captureScreenshotFromPreview(noteOverride?: string) {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = cropVideoToEmbed(video, captureArea);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Same Livevival watermark as the moment-attach capture path
    // (captureFrameBlob/drawWatermark) — this "Game screenshots" button was
    // the one capture path that skipped it, so a screenshot from here had
    // no branding at all.
    await drawWatermark(ctx, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) uploadScreenshot(blob, noteOverride);
    }, "image/jpeg", 0.85);
  }

  function handleScreenshotFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadScreenshot(file);
    e.target.value = "";
  }

  async function deleteScreenshot(id: string, imageUrl: string) {
    const { error: delErr } = await supabase.from("game_screenshots").delete().eq("id", id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    const path = imageUrl.split("/key-moment-screenshots/")[1];
    if (path) await supabase.storage.from("key-moment-screenshots").remove([path]);
    loadAll();
  }

  // ── Local capture (admin PC) ─────────────────────────────────────────
  // Only meaningful when match.update_source === "local_ocr": deterministic,
  // local, free OCR on a screen-shared tab — no AI, no rate limits, no
  // datacenter-IP bot detection, because it's the admin's own browser
  // watching whatever is already playing.
  //
  // "left"/"right" fields track whichever physical side of the broadcast
  // overlay they're calibrated against — ocr_left_team_id (set once per
  // match below) is what resolves "left" to a real team, so the regions
  // themselves never need recalibrating when sides swap between games.
  //
  // Trackers are no longer a hardcoded TypeScript union — which (phase,
  // category, variable) combinations exist for a given match is now rows in
  // capture_regions (phase/category/field/label + calibrated box), added,
  // edited, and removed from the UI below instead of compiled into the app.
  // `field` stays a stable string key (e.g. "player_kda_left_3",
  // "objective_right_tower") — the OCR dispatch below recovers which side/
  // slot/objective-type a given tracker is for straight from that key
  // (see fieldParts), rather than needing 10 near-identical hardcoded
  // branches per side per slot.
  type TrackerCategory =
    | "countdown"
    // Kept only so a pre-existing capture_regions row with this category
    // (if any admin ever added one) still types-checks when loaded —
    // draft timers are otherwise fully removed: no catalog entry, no
    // capture-tick handler, no manual-set UI. See the note by parseMmSs.
    | "draft_timer"
    | "draft_hero_pick"
    | "map_setting"
    | "game_timer"
    | "team_kills"
    | "objective"
    // Single-region alternatives to 3 "objective"/5 "player_kda" trackers
    // per side — one box spanning the whole tower/lord/turtle icon cluster
    // (or the whole 5-row KDA column) instead of one box per number, read
    // and split apart in one OCR pass (see parseObjectivesGroupCounts/
    // parseKdaGroupLines below). Faster to calibrate (one drag instead of
    // three or five) at the cost of needing every number in the region to
    // read cleanly on the same tick — the individual per-type/per-player
    // trackers stay available for broadcasts where that trade isn't worth
    // it (a laggy connection, a cramped HUD).
    | "objectives_group"
    | "kda_group"
    | "net_worth"
    | "player_kda"
    | "kill_banner"
    | "victory_banner"
    | "pause_word";
  type Side = "left" | "right";
  type Tracker = { id: string; phase: string; category: TrackerCategory; field: string; label: string };

  const KDA_SLOT_LABELS = ROLE_ORDER;
  const SIDES: { key: Side; label: string }[] = [
    { key: "left", label: "Left" },
    { key: "right", label: "Right" },
  ];

  // Every (phase, category, variable) combination an admin can add for a
  // match — the "Add tracker" control below offers whatever's in this
  // catalog for the selected phase, minus whatever's already added. Kept
  // deliberately narrow per-phase (only what's reliably readable and
  // actually needed) rather than every variable that could theoretically
  // be scraped off screen — GAME_FINISHED/TECHNICAL_PAUSE/SERIES_FINISHED
  // have no tracker of their own at all (victory/pause banners
  // proved unreliable and the phase transitions themselves are driven by
  // the admin's own controls, not OCR); DRAFT_COMPLETE likewise has none
  // (draft results come from the manual ban/pick simulation, not OCR).
  // Bans stay manual — ban slots show no text on screen, only an icon, so
  // there's nothing for deterministic OCR to read there.
  function catalogForPhase(phase: string): { category: TrackerCategory; field: string; label: string }[] {
    switch (phase) {
      case "MATCH_NOT_STARTED":
        return [{ category: "countdown", field: "countdown", label: "Pre-game countdown" }];
      case "DRAFT_STARTED": {
        // Draft timers removed per product decision — see the note by
        // parseMmSs above. map_setting is the only DRAFT_STARTED tracker
        // left.
        return [{ category: "map_setting", field: "map_setting", label: "Map setting (one-time, auto-selects the map)" }];
      }
      case "GAME_STARTED": {
        const items: { category: TrackerCategory; field: string; label: string }[] = [
          { category: "game_timer", field: "game_timer", label: "Game timer" },
          // Center-screen SAVAGE/MANIAC/etc. banner — the OCR side of this
          // (regex match + player-name extraction) already existed; it just
          // had no way to actually be added as a tracker until now.
          { category: "kill_banner", field: "kill_banner", label: "Kill banner (SAVAGE/MANIAC/etc.)" },
        ];
        for (const side of SIDES) items.push({ category: "team_kills", field: `team_kills_${side.key}`, label: `Team kills — ${side.label}` });
        for (const side of SIDES) items.push({ category: "net_worth", field: `net_worth_${side.key}`, label: `Net worth — ${side.label}` });
        // Tower/lord/turtle counts, one field per objective type per side —
        // fieldParts' objectiveType suffix match (`_tower`/`_lord`/`_turtle`)
        // is what routes each field's OCR read to applySingleObjectiveReading
        // for the right team+type, same as team_kills/net_worth route on the
        // `_left`/`_right` side substring.
        for (const side of SIDES) {
          for (const type of OBJECTIVE_TYPES) {
            items.push({
              category: "objective",
              field: `objective_${side.key}_${type}`,
              label: `Objective — ${side.label} ${type[0].toUpperCase()}${type.slice(1)}`,
            });
          }
        }
        // One box around the whole tower/lord/turtle icon cluster instead
        // of three — see OBJECTIVE_GROUP_ORDER for how the 3 numbers it
        // reads get split back out to a type each.
        for (const side of SIDES) {
          items.push({
            category: "objectives_group",
            field: `objectives_group_${side.key}`,
            label: `Objectives (combined) — ${side.label}: ${OBJECTIVE_GROUP_ORDER[side.key].join(" / ")}`,
          });
        }
        for (const side of SIDES) {
          for (let n = 1; n <= 5; n++) {
            items.push({
              category: "player_kda",
              field: `player_kda_${side.key}_${n}`,
              label: `K/D/A — ${side.label} #${n} (${KDA_SLOT_LABELS[n - 1]})`,
            });
          }
        }
        // One box around the whole 5-row KDA column instead of five — see
        // parseKdaGroupLines. Requires all 5 rows to read as clean x/x/x
        // triples on the same tick, in role order top-to-bottom, or the
        // whole read is skipped that tick (never a partial/misaligned
        // assignment — see the case "kda_group" handler).
        for (const side of SIDES) {
          items.push({
            category: "kda_group",
            field: `kda_group_${side.key}`,
            label: `K/D/A (combined) — ${side.label}: all 5, role order`,
          });
        }
        return items;
      }
      default:
        return [];
    }
  }

  // Pulls side/slot/objective-type back out of a field key built by the
  // catalog above — e.g. "player_kda_left_3" -> { side: "left", slot: 3 }.
  function fieldParts(field: string): { side: Side | null; slot: number | null; objectiveType: string | null } {
    const side: Side | null = field.includes("_left") ? "left" : field.includes("_right") ? "right" : null;
    const slotMatch = field.match(/_(\d)$/);
    const slot = slotMatch ? Number(slotMatch[1]) : null;
    const objectiveType = OBJECTIVE_TYPES.find((t) => field.endsWith(`_${t}`)) ?? null;
    return { side, slot, objectiveType };
  }
  // Where to float the variable-name label + Save/Cancel controls for a
  // region being placed/edited — directly above or below the box itself so
  // an admin never has to look away from what they just drew/selected to
  // find the controls that act on it. The canvas container clips overflow
  // (rounded corners on the video), so both axes are clamped to stay
  // within its bounds rather than letting a box near an edge push the
  // panel out and get cut off.
  function regionOverlayPos(box: RegionBox): { top: number; left: number; below: boolean } {
    const below = box.yPct + box.hPct <= 85;
    const top = below ? Math.min(96, box.yPct + box.hPct + 1) : Math.max(2, box.yPct - 10);
    const left = Math.min(Math.max(box.xPct, 1), 55);
    return { top, left, below };
  }
  type RegionBox = { xPct: number; yPct: number; wPct: number; hPct: number };

  // Historical: back when local capture self-shared this admin tab, this
  // tracked where the "Livestream" embed sat within the captured frame, so
  // every OCR read could crop down to just the stream instead of the whole
  // admin page around it. Capture now shares a separate, dedicated tab
  // instead (see startCapture) — the whole captured frame *is* the
  // stream — so this always stays null. Kept (not deleted) purely because
  // toFullFramePct/cropCanvasFor (the OCR tracker-read path) still take it
  // as a parameter and already treat null as "box coordinates are already
  // whole-frame percentages," which is exactly today's behavior; removing
  // it would mean touching that call site for no behavior change. The
  // screenshot/moment-capture paths no longer use this — they take the
  // real, admin-drawn captureArea below instead (see cropVideoToEmbed call
  // sites), since unlike tracker regions those crop straight from the
  // frame with no embed-relative composition to worry about.
  type EmbedFrame = { xPct: number; yPct: number; wPct: number; hPct: number };
  const embedFrame: EmbedFrame | null = null;

  // ── Captured area ─────────────────────────────────────────────────────
  // Optional hard boundary (full-frame percentages, same shape as
  // RegionBox) admins can draw on the Match capture canvas — useful when
  // the OS-level screen/window share includes more than just the
  // broadcast itself (extra desktop chrome, a second monitor). When set:
  // every tracker region gets clamped inside it on save (clampBoxToArea,
  // used by saveRegion/addTrackerWithRegion, so this also covers
  // auto-place and template-apply), and Screenshot/moment captures crop
  // to it directly (cropVideoToEmbed call sites now pass captureArea
  // instead of the always-null embedFrame above). null means "the whole
  // captured frame counts", identical to today's behavior. Stored as its
  // own capture_regions row (field "__capture_area__", category
  // "capture_area", phase "ANY") rather than a real tracker, so it's
  // filtered out of the trackers/regions load and never shows up in the
  // tracker catalog.
  const [captureArea, setCaptureArea] = useState<RegionBox | null>(null);
  const [captureAreaEditMode, setCaptureAreaEditMode] = useState(false);
  const [captureAreaDraft, setCaptureAreaDraft] = useState<RegionBox | null>(null);
  const captureAreaDragMode = useRef<DragMode | null>(null);
  const captureAreaDragStartPct = useRef<{ x: number; y: number } | null>(null);
  const captureAreaDragStartBox = useRef<RegionBox | null>(null);
  const captureAreaCropRectRef = useRef<DOMRect | null>(null);

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // When the current capture session actually started — lets the "every
  // tracker is stuck unhealthy" diagnostic below give reads a fair chance
  // (the first tick can't land for up to 5s, OCR itself takes a moment)
  // before concluding something's actually wrong instead of just cold.
  const captureStartedAtRef = useRef<number | null>(null);
  // Corner-drag resize state for region calibration. dragMode covers a
  // fresh draw, moving the whole box, or one of the 4 corner handles;
  // dragStartPct/dragStartBox snapshot where the drag began so every
  // subsequent mousemove computes a fresh box from the same origin
  // instead of drifting from incremental deltas. Window-level listeners
  // (not container-scoped) so a fast drag that briefly leaves the small
  // preview area doesn't drop the interaction.
  type DragMode = "draw" | "move" | "nw" | "ne" | "sw" | "se";
  const dragMode = useRef<DragMode | null>(null);
  const dragStartPct = useRef<{ x: number; y: number } | null>(null);
  const dragStartBox = useRef<RegionBox | null>(null);
  const cropRectRef = useRef<DOMRect | null>(null);
  // Which state a drag gesture writes into — "draftBox" is the existing
  // pick-tracker-then-draw flow (inline view, and full-screen edit mode);
  // "pendingFsBox" is full-screen's draw-then-pick flow, where a box can
  // exist with no tracker assigned yet. Read by the shared mousemove/mouseup
  // effect below so both flows can share one drag implementation.
  const dragTarget = useRef<"draftBox" | "pendingBox">("draftBox");
  // Guards the auto GAME_STARTED transition below so it only fires once
  // per game, not on every OCR tick that finds a readable timer.
  const autoStartedGameId = useRef<string | null>(null);
  // Map-setting detection only ever needs to fire once per game — without
  // this guard every OCR tick that still sees the map-select overlay on
  // screen would keep re-writing games.map, which is wasted work at best
  // and a footgun if the admin manually corrects it mid-draft at worst.
  const mapAutoSetForGame = useRef<string | null>(null);
  // Guards against overlapping ticks — GAME_STARTED scans up to 18 regions
  // sequentially (10 of those are the per-player K/D/A slots; vs. 1-4 for
  // every other phase), and each is a real tesseract.js recognize() call.
  // On a slower machine/frame that easily exceeds the 5s interval between
  // ticks; setInterval doesn't wait for its callback to finish, so without
  // this a new tick started reading from the
  // same Tesseract worker while the previous one was still mid-recognize —
  // the worker serializes those internally, so ticks just piled up behind
  // each other forever and the tracker looked stalled/dead once
  // GAME_STARTED's much longer field list was reached.
  const tickInFlight = useRef(false);

  const [captureActive, setCaptureActive] = useState(false);
  // Whether the "Local capture (this PC)" tracker calibration UI (edit
  // mode, video crop overlay, tracker table) is expanded. Starts open, but
  // see the auto-collapse effect by activeTrackers below — an admin who's
  // already finished setting a match up shouldn't have to scroll past this
  // every reload just to reach Livestream/Declare Winner/Moment log above.
  const [ocrDetailsOpen, setOcrDetailsOpen] = useState(true);
  // Reference livestream thumbnail (see the "Match capture" pane below) —
  // starts collapsed since the capture canvas above it is the thing an
  // admin actually calibrates/reads against; this is just a quick "does
  // the broadcast still match what I calibrated" glance, one click away,
  // pinned next to the canvas instead of buried at the bottom of a
  // separately-scrolling section like it used to be.
  const [referenceStreamOpen, setReferenceStreamOpen] = useState(false);
  const ocrAutoCollapsedRef = useRef(false);
  const [calibratingField, setCalibratingField] = useState<string | null>(null);
  // Live-editable draft of the region currently being calibrated — shown
  // with a preview box + corner handles, not persisted to capture_regions
  // until the admin explicitly locks it (see lockDraftBox). Starts from
  // the field's existing saved region when there is one, so "Resize" is a
  // real corner-drag adjustment instead of redrawing from scratch.
  const [draftBox, setDraftBox] = useState<RegionBox | null>(null);
  const [manualTimeInputs, setManualTimeInputs] = useState<Record<string, string>>({});
  // Trackers this match currently has configured (loaded from
  // capture_regions, tournament defaults layered under match-specific rows —
  // see the load effect below) — replaces the old hardcoded CAPTURE_FIELDS/
  // PHASE_CAPTURE_FIELDS arrays. `regions`/`readings` stay keyed by the same
  // `field` string as before; only what populates them (data instead of a
  // compiled-in list) changed.
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [regions, setRegions] = useState<Record<string, RegionBox | null>>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  // Diagnostic-only OCR freshness/confidence per tracker field — purely a
  // read-side overlay on top of `readings` above, never consulted by any
  // capture/parsing/write logic (see captureTickBody). lastGoodAt is the
  // last tick that returned non-blank OCR text for this field; confidence
  // is Tesseract's own overall page-confidence (0-100) for the most recent
  // recognize() call, good read or not — already returned by tesseract.js
  // on every tick, just not read into anything until now. Lets the tracker
  // table below show, at a glance, whether a field is actively updating
  // and how much Tesseract itself trusts the last read.
  const [trackerHealth, setTrackerHealth] = useState<Record<string, { lastGoodAt: number | null; confidence: number | null }>>({});
  const [suggestion, setSuggestion] = useState<{ type: string; raw: string; playerId?: string | null; playerName?: string | null } | null>(null);
  // A kill banner (SAVAGE/MANIAC/etc.) typically stays on screen for
  // several seconds — long enough to get re-read on the next OCR tick and
  // pop the same suggestion right back up after the admin already hit
  // Dismiss on it. Keyed by moment type, valued at the timestamp the
  // suppression lifts; checked before a new suggestion of that type is
  // ever raised.
  const dismissedSuggestionUntilRef = useRef<Record<string, number>>({});
  const [consistencyWarning, setConsistencyWarning] = useState<string | null>(null);

  // OCR-assisted, admin-confirmed: a plausible reading (passes the
  // never-decreases/spike-cap guards already in captureTickBody) still
  // auto-applies exactly like before — that's the whole point of
  // automating the common case. This queue is for the readings a guard
  // would otherwise have silently clamped or thrown away: instead of
  // trusting them blind (the old fully-autonomous behavior) or losing
  // them entirely, they surface here with the raw OCR text, Tesseract's
  // own confidence, and one explicit action to actually apply the value —
  // the admin decides, not the guard. Keyed by tracker field so a repeat
  // flag on the same field just refreshes in place instead of stacking.
  type FlaggedReading = {
    field: string;
    label: string;
    raw: string;
    confidence: number | null;
    reason: string;
    flaggedAt: number;
    apply: () => void | Promise<void>;
  };
  const [flaggedReadings, setFlaggedReadings] = useState<Record<string, FlaggedReading>>({});
  // Low-confidence reads (the same yellow/red bands confidenceColor below
  // draws) are auto-ignored instead of queued for confirmation — a guard
  // holding back a read Tesseract itself wasn't confident about in the
  // first place is almost always a genuine misread, not a real correction
  // worth interrupting the admin for. Only a genuinely high-confidence
  // (green, 80+) read that a guard still held back, or one with no
  // Tesseract confidence attached at all (null — can't be judged either
  // way, so it's given the benefit of the doubt), actually reaches the
  // "N readings need your confirmation" queue now.
  function flagReading(field: string, entry: Omit<FlaggedReading, "field" | "flaggedAt">) {
    if (entry.confidence != null && entry.confidence < 80) {
      dismissFlaggedReading(field);
      return;
    }
    setFlaggedReadings((prev) => ({ ...prev, [field]: { field, flaggedAt: Date.now(), ...entry } }));
  }
  function dismissFlaggedReading(field: string) {
    setFlaggedReadings((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }
  async function applyFlaggedReading(field: string) {
    const entry = flaggedReadings[field];
    if (!entry) return;
    await entry.apply();
    dismissFlaggedReading(field);
  }
  // Green/yellow/red on Tesseract's own page-confidence for the most
  // recent read of a field — same bands used for both the flagged-reading
  // queue and the small dot on each calibrated tracker box.
  function confidenceColor(confidence: number | null): string {
    if (confidence == null) return "bg-white/20";
    if (confidence >= 80) return "bg-emerald-500";
    if (confidence >= 50) return "bg-yellow-500";
    return "bg-red-500";
  }

  // ── Slide-anywhere tracker placement (inline canvas) ──────────────────
  // A second way to add a tracker on the SAME big canvas as the "pick a
  // tracker, then draw its box" flow below — this one draws first
  // (pendingBox can exist with no tracker assigned yet), then a small
  // picker assigns phase+variable. Both methods write the same
  // capture_regions rows; draftBox/calibratingField stay reserved for
  // "editing/drawing a tracker that's already been chosen" (the older
  // method). This used to only work inside a separate full-screen portal
  // (removed — placement drifted whenever the browser/video resized or
  // moved mid-session), so it now lives directly on the enlarged inline
  // canvas instead.
  const [canvasPhaseFilter, setCanvasPhaseFilter] = useState<string>("");
  // Explicit toggle for "am I dragging tracker boxes, or interacting with
  // whatever's playing underneath" — replaces any gesture-based tap-vs-drag
  // guessing (fragile, fights the video's own click handling) with a plain
  // on/off switch. OFF (default): the canvas' own onMouseDown never starts a
  // drag, and existing tracker boxes render as a thin, non-interactive
  // outline. ON: full drag/resize/click-to-edit behavior, unchanged from
  // before this toggle existed.
  const [trackerEditMode, setTrackerEditMode] = useState(false);
  const [pendingBox, setPendingBox] = useState<RegionBox | null>(null);
  const [pendingBoxPhase, setPendingBoxPhase] = useState<string>("");
  const [pendingBoxField, setPendingBoxField] = useState<string>("");
  useEffect(() => {
    if (pendingBox && !pendingBoxPhase) {
      const fallback = match?.state && TRACKER_PHASES.includes(match.state) ? match.state : TRACKER_PHASES[0];
      setPendingBoxPhase(canvasPhaseFilter || fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBox]);
  // Auto-follow the match's current live phase — an admin can still
  // override it manually (e.g. to calibrate a tracker ahead of time for a
  // phase that hasn't started yet), but it snaps back to the live phase
  // whenever that changes, per the "filter should auto-follow" ask. Only
  // ever snaps to one of the two tracker phases — the match itself can be
  // in any phase (draft, finished, etc.), but there's nothing to track
  // there, so the filter just stays wherever it already was instead.
  useEffect(() => {
    if (match?.state && TRACKER_PHASES.includes(match.state)) setCanvasPhaseFilter(match.state);
  }, [match?.state]);

  // ── Full-frame AI capture (no calibration) ───────────────────────────
  // Alternative to the manual crop-region OCR above: sends the whole
  // captured frame to /api/ocr/analyze-frame (Groq vision) every tick and
  // applies whatever it finds directly, instead of the admin dragging
  // pixel boxes around each element. Default mode — the manual regions
  // above stay available as a free, deterministic fallback if AI analysis
  // isn't configured (GROQ_API_KEY unset) or a tournament's overlay trips
  // it up.
  type AiDetection = {
    phase: string;
    game_timer_mm_ss: string | null;
    winning_team_name: string | null;
    key_moment_banner: string;
    key_moment_player_name: string | null;
    draft_actions: { type: "pick" | "ban"; team_name: string; hero_name: string }[];
    player_stats: { player_name: string; team_name: string; hero_name: string | null; kills: number | null; deaths: number | null; assists: number | null; gold: number | null }[];
    net_worth: { team_a_gold: number | null; team_b_gold: number | null };
    confidence: number;
  };
  // Locked to "manual" from the UI (see the Local capture panel below) —
  // AI vision stays fully implemented but unreachable until manual OCR is
  // proven out, per explicit instruction. setCaptureMode is kept (not
  // deleted) since applyAiDetection/captureFrameAndAnalyze still exist and
  // will need it again once AI is re-enabled.
  const [captureMode, setCaptureMode] = useState<"ai" | "manual">("manual");
  const [heroes, setHeroes] = useState<{ id: string; name: string; icon_url: string | null }[]>([]);
  const [overlayHint, setOverlayHint] = useState("");
  const [aiDetection, setAiDetection] = useState<AiDetection | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [suggestedWinner, setSuggestedWinner] = useState<string | null>(null);
  const lastAutoKeyMoment = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("heroes").select("id, name, icon_url").order("name");
      setHeroes((data as { id: string; name: string; icon_url: string | null }[]) ?? []);
    })();
  }, []);

  function normalize(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function matchTeamId(teamName?: string | null): string | null {
    if (!teamName || !match) return null;
    const n = normalize(teamName);
    if (match.team_a && (normalize(match.team_a.name).includes(n) || n.includes(normalize(match.team_a.name)))) return match.team_a.id;
    if (match.team_b && (normalize(match.team_b.name).includes(n) || n.includes(normalize(match.team_b.name)))) return match.team_b.id;
    return null;
  }
  function matchHeroId(heroName?: string | null): string | null {
    if (!heroName) return null;
    const n = normalize(heroName);
    return (heroes.find((h) => normalize(h.name) === n) ?? heroes.find((h) => normalize(h.name).includes(n) || n.includes(normalize(h.name))))?.id ?? null;
  }
  function matchPlayerId(playerName?: string | null, teamId?: string | null): string | null {
    if (!playerName) return null;
    const n = normalize(playerName);
    const pool = teamId ? players.filter((p) => p.team_id === teamId) : players;
    return (pool.find((p) => normalize(p.ign) === n) ?? pool.find((p) => normalize(p.ign).includes(n) || n.includes(normalize(p.ign))))?.id ?? null;
  }
  // ocr_left_team_id resolves which real team the "left"-labeled regions
  // belong to for this match; unset defaults to team_a=left so a fresh
  // match still works before the admin explicitly sets it.
  function resolveLeftTeamId(): string | null {
    return match?.ocr_left_team_id ?? match?.team_a?.id ?? null;
  }
  function resolveRightTeamId(): string | null {
    const left = resolveLeftTeamId();
    return match?.team_a?.id === left ? match?.team_b?.id ?? null : match?.team_a?.id ?? null;
  }
  async function setOcrLeftTeam(teamId: string) {
    if (!match) return;
    await supabase.from("matches").update({ ocr_left_team_id: teamId || null }).eq("id", match.id);
    loadAll();
  }

  const DRAFT_PHASES = ["DRAFT_STARTED", "DRAFT_COMPLETE"];
  // Roster is fixed once the draft starts — the players set before then are
  // the final list for this game. "+ Add player" on the Live scoreboard
  // (for a substitute the draft didn't already pick up) only reopens
  // before the draft begins, or again once the game's over (or the match
  // gets reset back to MATCH_NOT_STARTED).
  const ROSTER_ADD_PHASES = new Set(["MATCH_NOT_STARTED", "GAME_FINISHED", "SERIES_FINISHED"]);

  // ── Draft: manual ban/pick simulation ─────────────────────────────────
  // Replaces OCR/AI-vision draft detection entirely. Bans show no text on
  // screen (only an icon) so deterministic OCR was never reliable there,
  // and hero-pick detection during a fast-moving draft was the single
  // riskiest OCR surface in the console. The admin instead logs each pick
  // and ban by hand from a searchable hero grid, in the exact fixed order
  // a real tournament draft follows — modeled as one flat array of atomic
  // {side, type} actions rather than named "steps" (some of which cover
  // two heroes for the same team back-to-back), since a flat array turns
  // every "double step" into just two consecutive same-side entries with
  // no special-casing anywhere in the advance logic.
  type DraftSide = "blue" | "red";
  type DraftAtomicAction = { side: DraftSide; type: "ban" | "pick" };
  function buildDraftSequence(): DraftAtomicAction[] {
    const seq: DraftAtomicAction[] = [];
    const ban = (side: DraftSide, n = 1) => { for (let i = 0; i < n; i++) seq.push({ side, type: "ban" }); };
    const pick = (side: DraftSide, n = 1) => { for (let i = 0; i < n; i++) seq.push({ side, type: "pick" }); };
    // Revised order (10 bans + 10 picks, 20 steps total) — replaces the
    // earlier 12-ban/10-pick MLBB-realistic order per an explicit
    // site-owner correction of the exact sequence.
    ban("blue"); ban("red"); ban("blue"); ban("red"); ban("blue"); ban("red"); // Ban 1: B1,R1,B2,R2,B3,R3
    pick("blue"); pick("red", 2); pick("blue", 2); pick("red");                // Pick 1: Blue P1, Red P1+P2, Blue P2+P3, Red P3
    ban("red"); ban("blue"); ban("red"); ban("blue");                        // Ban 2: R4,B4,R5,B5
    pick("red"); pick("blue", 2); pick("red");                                // Pick 2: Red P4, Blue P4+P5, Red P5
    return seq; // 10 bans + 10 picks
  }
  const DRAFT_SEQUENCE = buildDraftSequence();

  type DraftSimState = {
    blueTeamId: string;
    redTeamId: string;
    stepIndex: number;
    committed: { teamId: string; type: "ban" | "pick"; heroName: string }[];
  };
  const [draftSim, setDraftSim] = useState<DraftSimState | null>(null);
  const [simHeroSearch, setSimHeroSearch] = useState("");

  // "Ban 2" / "Pick 3" — counts same-side-same-type entries up to and
  // including this step, so the turn banner reads naturally regardless of
  // whether the step before it belonged to the same team or not.
  function draftStepLabel(stepIndex: number): string {
    const step = DRAFT_SEQUENCE[stepIndex];
    const n = DRAFT_SEQUENCE.slice(0, stepIndex + 1).filter((s) => s.side === step.side && s.type === step.type).length;
    return `${step.type === "ban" ? "Ban" : "Pick"} ${n}`;
  }

  async function startDraftSimulation(blueTeamId: string) {
    if (!game || !match?.team_a || !match?.team_b) return;
    const redTeamId = blueTeamId === match.team_a.id ? match.team_b.id : match.team_a.id;
    if (!confirm("Start draft simulation? This clears any existing picks/bans for this game.")) return;
    await supabase.from("hero_picks_bans").delete().eq("game_id", game.id);
    setDraftSim({ blueTeamId, redTeamId, stepIndex: 0, committed: [] });
    setSimHeroSearch("");
    loadAll();
  }
  // Soft — only abandons the in-memory turn tracker. Whatever's already
  // been logged to hero_picks_bans for completed steps stays; "Reset"
  // below is the destructive one that also deletes those rows.
  function stopDraftSimulation() {
    setDraftSim(null);
    setSimHeroSearch("");
  }
  // Rewinds exactly one step — the last-logged hero_picks_bans row (highest
  // pick_order for this game) plus the matching auto-logged Moment list
  // entry, both fetched fresh from the DB rather than trusting client
  // state, since pick_order is the actual source of truth for "last."
  // Repeatable back to stepIndex 0 (undo does nothing before the first
  // pick/ban of the draft).
  async function undoLastDraftStep() {
    if (!draftSim || !game || draftSim.stepIndex === 0) return;
    const lastCommitted = draftSim.committed[draftSim.committed.length - 1];
    if (!lastCommitted) return;
    if (!confirm(`Undo "${lastCommitted.heroName}" (${lastCommitted.type})? This removes it from Hero picks & bans and the Moment list.`)) return;

    const { data: lastPb } = await supabase
      .from("hero_picks_bans")
      .select("id")
      .eq("game_id", game.id)
      .order("pick_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastPb) await supabase.from("hero_picks_bans").delete().eq("id", (lastPb as { id: string }).id);

    const { data: lastKm } = await supabase
      .from("key_moments")
      .select("id")
      .eq("game_id", game.id)
      .eq("type", lastCommitted.type)
      .eq("team_id", lastCommitted.teamId)
      .eq("source", "auto")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastKm) await supabase.from("key_moments").delete().eq("id", (lastKm as { id: string }).id);

    setDraftSim({ ...draftSim, stepIndex: draftSim.stepIndex - 1, committed: draftSim.committed.slice(0, -1) });
    setSimHeroSearch("");
    loadAll();
  }
  async function resetDraftSimulation() {
    if (!game) return;
    if (!confirm("Reset the draft? This deletes every pick/ban logged so far for this game.")) return;
    await supabase.from("hero_picks_bans").delete().eq("game_id", game.id);
    setDraftSim(null);
    setSimHeroSearch("");
    loadAll();
  }
  async function logSimulationStep(heroName: string) {
    if (!draftSim || !game || !match) return;
    const step = DRAFT_SEQUENCE[draftSim.stepIndex];
    const teamId = step.side === "blue" ? draftSim.blueTeamId : draftSim.redTeamId;
    const { error } = await supabase.from("hero_picks_bans").insert({
      game_id: game.id,
      match_id: matchId,
      team_id: teamId,
      player_id: null, // no hero-to-player assignment during the simulation itself
      hero_name: heroName,
      hero_id: heroes.find((h) => h.name === heroName)?.id ?? null,
      type: step.type,
      pick_order: draftSim.committed.length + 1,
    });
    if (error) {
      setError(error.message);
      return;
    }
    await logPickBanMoment(step.type, teamId, heroName, null);
    const nextIndex = draftSim.stepIndex + 1;
    setDraftSim({ ...draftSim, stepIndex: nextIndex, committed: [...draftSim.committed, { teamId, type: step.type, heroName }] });
    setSimHeroSearch("");
    if (nextIndex >= DRAFT_SEQUENCE.length) {
      setDraftSim(null);
      await setMatchPhase("DRAFT_COMPLETE");
    }
    loadAll();
  }

  // Post-simulation, pre-Finish: the simulation logs picks with no player_id
  // (no hero-to-player assignment happens during it), so once it's done the
  // admin assigns each picked hero to whichever roster player is actually
  // playing it — writes straight onto that pick's own row (not a new one)
  // and syncs the Live Scoreboard's hero column the same way a manual pick
  // already does.
  async function assignHeroToPlayer(pickBanId: string, playerId: string, heroName: string) {
    const { error } = await supabase.from("hero_picks_bans").update({ player_id: playerId }).eq("id", pickBanId);
    if (error) {
      setError(error.message);
      return;
    }
    await updateStat(playerId, "hero_name", heroName);
    loadAll();
  }


  // Adds a match-local custom player (a sub not in the `players` table at
  // all) directly onto an already-logged pick — sets custom_player_name/
  // custom_player_role on that hero_picks_bans row instead of player_id,
  // scoped to this one match/game since the row itself is match-scoped.
  // Everything downstream (Live Scoreboard, KDA entry) picks this up
  // through the `custom:<pick-ban id>` synthetic id — see isCustomPlayerId.
  async function addCustomPlayerToPick(pickBanId: string) {
    const name = prompt("Custom player name (in-game name):")?.trim();
    if (!name) return;
    const role = prompt("Role (optional — exp/jungle/mid/gold/roam):")?.trim() || null;
    const { error } = await supabase
      .from("hero_picks_bans")
      .update({ player_id: null, custom_player_name: name, custom_player_role: role })
      .eq("id", pickBanId);
    if (error) {
      setError(error.message);
      return;
    }
    loadAll();
  }

  // `alreadyApplied` comes from /api/ocr/analyze-frame's own response when
  // the relay write path ran server-side (see captureFrameAndAnalyze,
  // which now passes matchId/gameId so the route commits player_stats/
  // net_worth itself instead of just returning the detection) — skips
  // redoing those two writes client-side so a frame's data never lands
  // twice. Everything else here (timer, suggestions) still runs
  // client-side regardless, since those either need a live UI to confirm
  // against or are cheap enough not to bother moving.
  async function applyAiDetection(detection: AiDetection, alreadyApplied?: { playerStatsApplied: number; netWorthApplied: boolean }) {
    if (!game || !match) return;

    const timerMatch = detection.game_timer_mm_ss?.match(/(\d{1,2}):(\d{2})/);
    if (timerMatch) {
      const newSeconds = Number(timerMatch[1]) * 60 + Number(timerMatch[2]);
      const knownSeconds = lastPersistedSeconds.current ?? game.current_time_seconds ?? null;
      // Same never-decreases guard the manual OCR path's game_timer case
      // applies — a vision-model misread clock is exactly as capable of
      // reading a garbled lower value as Tesseract is, and the clock only
      // counts up during live play.
      if (knownSeconds == null || newSeconds >= knownSeconds) {
        setMinute(Number(timerMatch[1]));
        updateGameClock(Number(timerMatch[1]), Number(timerMatch[2]));
      }
    }
    if (detection.phase === "IN_GAME") maybeAutoStartGame();

    // Draft is a manual ban/pick simulation now (see draftSim below) — no
    // more OCR/AI-vision draft detection, so detection.draft_actions (still
    // present on the API response, still shown in the raw AI-status debug
    // panel below) is intentionally not applied to hero_picks_bans here.

    // Game-ongoing's tracker area — stats, net worth, moment banners — only
    // applies while the admin actually has this phase selected, same
    // principle as the manual crop-region scoping above. Otherwise a stray
    // vision-model reading during e.g. a Technical pause could write
    // nonsense stats nobody asked for.
    if (match.state === "GAME_STARTED") {
      // Same never-decreases invariant the manual OCR path enforces
      // (captureTickBody) — a vision-model misread is exactly as capable
      // of reporting a garbled lower number as a Tesseract misread is, and
      // kills/deaths/assists/gold only ever go up during a live game.
      // Clamped per-field so a correctly-read stat still lands even if
      // another field on the same row misread low. Skipped entirely when
      // alreadyApplied is set — the relay route already committed these
      // (with the same guards) server-side.
      if (!alreadyApplied) {
        for (const row of detection.player_stats ?? []) {
          const teamId = matchTeamId(row.team_name);
          const playerId = matchPlayerId(row.player_name, teamId);
          if (!playerId) continue;
          const existing = stats.find((s) => s.player_id === playerId);
          const kills = row.kills != null ? (existing?.kills != null ? Math.max(row.kills, existing.kills) : row.kills) : existing?.kills ?? null;
          const deaths = row.deaths != null ? (existing?.deaths != null ? Math.max(row.deaths, existing.deaths) : row.deaths) : existing?.deaths ?? null;
          const assists = row.assists != null ? (existing?.assists != null ? Math.max(row.assists, existing.assists) : row.assists) : existing?.assists ?? null;
          const gold = row.gold != null ? (existing?.gold != null ? Math.max(row.gold, existing.gold) : row.gold) : existing?.gold ?? null;
          await supabase.from("player_stats").upsert(
            {
              game_id: game.id,
              match_id: matchId,
              player_id: playerId,
              hero_name: row.hero_name ?? existing?.hero_name ?? null,
              hero_id: matchHeroId(row.hero_name),
              kills,
              deaths,
              assists,
              gold,
            },
            { onConflict: "game_id,player_id" }
          );
        }

        if (detection.net_worth?.team_a_gold != null || detection.net_worth?.team_b_gold != null) {
          // Same never-decreases + per-tick spike-cap guard as the manual
          // path's net-worth block — a vision-model read jumping far
          // beyond a plausible single-tick gain is far more likely a
          // misread digit than real gold.
          const MAX_NET_WORTH_GAIN_PER_TICK = 8000;
          const knownAGold = latestNetWorth?.team_a_gold ?? null;
          const knownBGold = latestNetWorth?.team_b_gold ?? null;
          const clamp = (known: number | null, read: number | null) => {
            if (read == null) return known ?? null;
            const floored = known != null && read < known ? known : read;
            return known != null && floored - known > MAX_NET_WORTH_GAIN_PER_TICK ? known + MAX_NET_WORTH_GAIN_PER_TICK : floored;
          };
          await supabase.from("net_worth_snapshots").insert({
            game_id: game.id,
            match_id: matchId,
            minute_mark: minute,
            team_a_gold: clamp(knownAGold, detection.net_worth?.team_a_gold ?? null),
            team_b_gold: clamp(knownBGold, detection.net_worth?.team_b_gold ?? null),
          });
        }
      }

      // Dedup within a cooldown — a banner lingers on screen for several
      // seconds, so without this the same suggestion would re-pop on every
      // tick. Surfaces via the same confirm popup as the OCR keyword path
      // (setSuggestion) instead of auto-inserting — the admin confirms
      // every detected moment either way now, AI-vision included.
      if (detection.key_moment_banner && detection.key_moment_banner !== "NONE") {
        const playerId = matchPlayerId(detection.key_moment_player_name);
        const key = `${detection.key_moment_banner}:${playerId ?? ""}`;
        const type = detection.key_moment_banner.toLowerCase();
        const now = Date.now();
        // Same shared cooldown the OCR kill-banner path uses (see
        // dismissedSuggestionUntilRef) — an admin hitting Cancel on this
        // exact popup should suppress it here too, not just on the
        // separate OCR-tick path, since both read the same on-screen
        // banner and both would otherwise pop it right back up.
        const dismissed = (dismissedSuggestionUntilRef.current[type] ?? 0) > now;
        if (!dismissed && (lastAutoKeyMoment.current.key !== key || now - lastAutoKeyMoment.current.at > 60000)) {
          lastAutoKeyMoment.current = { key, at: now };
          setSuggestion({
            type,
            raw: detection.key_moment_player_name ? `${detection.key_moment_player_name} ${detection.key_moment_banner}` : detection.key_moment_banner,
            playerId,
            playerName: playerId ? players.find((p) => p.id === playerId)?.ign ?? null : detection.key_moment_player_name ?? null,
          });
        }
      }
    }

    // Surfaced, not auto-applied — declareGameWinner() closes out the
    // series and already requires a confirm() click; too consequential to
    // fire from an unattended tick. Deliberately allowed during
    // GAME_STARTED (the natural transition — this is what tells the admin
    // the game just ended in the first place) as well as GAME_FINISHED;
    // excluded from earlier phases (draft, waiting) where a misread is
    // more likely to be an unrelated overlay.
    if (
      (match.state === "GAME_STARTED" || match.state === "GAME_FINISHED") &&
      (detection.phase === "VICTORY_DEFEAT_SCREEN" || detection.phase === "POST_GAME_STATS") &&
      detection.winning_team_name
    ) {
      const teamId = matchTeamId(detection.winning_team_name);
      if (teamId) setSuggestedWinner(teamId);
    }

    loadAll();
  }

  async function captureFrameAndAnalyze() {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) return;
    // Same hard stop as the manual-OCR pipeline (captureTickBody) — once
    // this game is finished, no further gameplay stats get written or even
    // sent for analysis.
    if (game?.status === "finished") return;

    // Vision models tokenize images by pixel area, not file size — sending
    // the full 1920x1080 (or higher) capture straight through burned ~6.2k
    // of an 8k tokens-per-minute free-tier budget on a SINGLE frame,
    // guaranteeing a 429 on every request regardless of which vision model
    // is behind it. On-screen HUD text/timer/KDA is still perfectly
    // readable well below full resolution, so downscale to a fixed max
    // width before encoding — this is the actual fix, independent of model
    // choice.
    const embedCanvas = cropVideoToEmbed(video, captureArea);
    if (!embedCanvas) return;
    const MAX_WIDTH = 960;
    const scale = Math.min(1, MAX_WIDTH / embedCanvas.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(embedCanvas.width * scale);
    canvas.height = Math.round(embedCanvas.height * scale);
    canvas.getContext("2d")?.drawImage(embedCanvas, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.6);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setAiStatus("Not signed in.");
      return;
    }

    try {
      // matchId/gameId opt this request into the relay write path — the
      // route commits player_stats/net_worth itself (same guards as
      // below) before responding, instead of this tab needing to survive
      // long enough to receive the response and write them itself. See
      // applyAiDetection's alreadyApplied param.
      const res = await fetch("/api/ocr/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageBase64, overlayHint: overlayHint || undefined, matchId, gameId: game?.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiStatus(data.error ?? "Analysis failed.");
        return;
      }
      const { applied, ...detection } = data as AiDetection & {
        applied?: { playerStatsApplied: number; netWorthApplied: boolean; skippedReason?: string };
      };
      setAiDetection(detection as AiDetection);
      setAiStatus(applied?.skippedReason ?? null);
      await applyAiDetection(detection as AiDetection, applied);
    } catch (err) {
      setAiStatus((err as Error).message);
    }
  }

  // ── AI-suggested tracker layout ──────────────────────────────────────
  // One screenshot of the current capture → a vision model locates each
  // standard HUD element → those boxes get placed as real trackers, same
  // "never touches a field that's already tracked" contract as Auto-place/
  // Apply-template. Separate from the AI full-frame *capture* pipeline
  // above (captureFrameAndAnalyze/applyAiDetection, which reads game state
  // on a recurring interval) — this only ever runs once, on demand, and
  // only ever proposes tracker positions, never writes any game data
  // itself.
  const AI_LAYOUT_FIELD_MAP: Record<string, { category: TrackerCategory; label: string }> = {
    game_timer: { category: "game_timer", label: "Game timer" },
    kill_banner: { category: "kill_banner", label: "Kill banner (SAVAGE/MANIAC/etc.)" },
    net_worth_left: { category: "net_worth", label: "Net worth — Left" },
    net_worth_right: { category: "net_worth", label: "Net worth — Right" },
    team_kills_left: { category: "team_kills", label: "Team kills — Left" },
    team_kills_right: { category: "team_kills", label: "Team kills — Right" },
    objectives_group_left: { category: "objectives_group", label: `Objectives (combined) — Left: ${OBJECTIVE_GROUP_ORDER.left.join(" / ")}` },
    objectives_group_right: { category: "objectives_group", label: `Objectives (combined) — Right: ${OBJECTIVE_GROUP_ORDER.right.join(" / ")}` },
    kda_group_left: { category: "kda_group", label: "K/D/A (combined) — Left: all 5, role order" },
    kda_group_right: { category: "kda_group", label: "K/D/A (combined) — Right: all 5, role order" },
  };
  const [aiLayoutSuggesting, setAiLayoutSuggesting] = useState(false);
  const [aiLayoutStatus, setAiLayoutStatus] = useState<string | null>(null);
  async function suggestLayoutFromScreenshot() {
    const video = previewRef.current;
    if (!video || video.videoWidth === 0) {
      setAiLayoutStatus("No capture frame available yet — start capture first.");
      return;
    }
    setAiLayoutSuggesting(true);
    setAiLayoutStatus(null);
    try {
      // Cropped to captureArea (if set) so the model only ever sees the
      // same region trackers are constrained to — composeFromCaptureArea
      // below converts its response back to full-frame percentages.
      const embedCanvas = cropVideoToEmbed(video, captureArea);
      if (!embedCanvas) {
        setAiLayoutStatus("Capture frame too small to read.");
        return;
      }
      const MAX_WIDTH = 960;
      const scale = Math.min(1, MAX_WIDTH / embedCanvas.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(embedCanvas.width * scale);
      canvas.height = Math.round(embedCanvas.height * scale);
      canvas.getContext("2d")?.drawImage(embedCanvas, 0, 0, canvas.width, canvas.height);
      const imageBase64 = canvas.toDataURL("image/jpeg", 0.85);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setAiLayoutStatus("Not signed in.");
        return;
      }

      const res = await fetch("/api/admin/ai-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imageBase64 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiLayoutStatus(data.error ?? "Layout suggestion failed.");
        return;
      }
      const regions = (data.regions ?? []) as { field: string; x_pct: number; y_pct: number; w_pct: number; h_pct: number }[];
      let placed = 0;
      let skipped = 0;
      for (const r of regions) {
        const mapping = AI_LAYOUT_FIELD_MAP[r.field];
        if (!mapping) continue;
        if (trackers.some((t) => t.phase === "GAME_STARTED" && t.field === r.field)) {
          skipped++;
          continue;
        }
        const box = composeFromCaptureArea({ xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct }, captureArea);
        await addTrackerWithRegion("GAME_STARTED", mapping.category, r.field, mapping.label, box);
        placed++;
      }
      setAiLayoutStatus(
        regions.length === 0
          ? "The model didn't confidently locate any tracker elements in this frame — try again once the scoreboard/HUD is clearly visible, or place trackers manually."
          : `Placed ${placed} tracker${placed === 1 ? "" : "s"} from the screenshot${skipped > 0 ? `, skipped ${skipped} already tracked` : ""}.`
      );
    } catch (err) {
      setAiLayoutStatus((err as Error).message);
    } finally {
      setAiLayoutSuggesting(false);
    }
  }

  // Set once the tournament-defaults/match-regions fetch below has actually
  // resolved (success or not) — gates autoPlaceDefaultTrackers further down
  // so it never fires against the transient "trackers is still []" state
  // that's true for an instant on every load, before this effect's fetch
  // has had a chance to come back with whatever's really configured.
  const [trackersLoaded, setTrackersLoaded] = useState(false);
  useEffect(() => {
    if (!matchId) return;
    (async () => {
      // Tournament-wide defaults first, then match-specific rows layered on
      // top — a match that was never calibrated inherits the tournament's
      // saved trackers/regions; one that was calibrated keeps its own.
      // "overlay_hint" is a text-only row (crop-region columns stay null for
      // it, phase 'ANY') reusing this same table/scoping instead of a
      // dedicated one.
      const cols = "id, field, phase, category, label, x_pct, y_pct, w_pct, h_pct, hint_text";
      const [{ data: tournamentDefaults }, { data: matchRegions }] = await Promise.all([
        match?.tournament_id
          ? supabase.from("capture_regions").select(cols).eq("tournament_id", match.tournament_id)
          : Promise.resolve({ data: [] as { id: string; field: string; phase: string; category: string; label: string | null; x_pct: number | null; y_pct: number | null; w_pct: number | null; h_pct: number | null; hint_text: string | null }[] }),
        supabase.from("capture_regions").select(cols).eq("match_id", matchId),
      ]);
      const nextTrackers: Tracker[] = [];
      const nextRegions: Record<string, RegionBox | null> = {};
      for (const r of [...(tournamentDefaults ?? []), ...(matchRegions ?? [])]) {
        if (r.category === "overlay_hint" || r.category === "capture_area") continue;
        const idx = nextTrackers.findIndex((t) => t.field === r.field);
        const tracker: Tracker = { id: r.id, phase: r.phase, category: r.category as TrackerCategory, field: r.field, label: r.label ?? r.field };
        if (idx === -1) nextTrackers.push(tracker);
        else nextTrackers[idx] = tracker; // match-specific row overrides the tournament default with the same field
        nextRegions[r.field] = r.x_pct != null ? { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct } : null;
      }
      setTrackers(nextTrackers);
      setRegions((prev) => ({ ...prev, ...nextRegions }));
      const tournamentHint = tournamentDefaults?.find((r) => r.category === "overlay_hint")?.hint_text;
      const matchHint = matchRegions?.find((r) => r.category === "overlay_hint")?.hint_text;
      if (matchHint ?? tournamentHint) setOverlayHint(matchHint ?? tournamentHint ?? "");
      // Captured area is per-machine (tied to whatever the admin actually
      // shares), so only ever comes from the match-specific row — no
      // tournament-default fallback the way overlay_hint/trackers get.
      const matchCaptureArea = matchRegions?.find((r) => r.category === "capture_area");
      setCaptureArea(
        matchCaptureArea?.x_pct != null
          ? { xPct: matchCaptureArea.x_pct, yPct: matchCaptureArea.y_pct!, wPct: matchCaptureArea.w_pct!, hPct: matchCaptureArea.h_pct! }
          : null
      );
      setTrackersLoaded(true);
    })();
  }, [matchId, match?.tournament_id]);

  async function removeTracker(tracker: Tracker) {
    await supabase.from("capture_regions").delete().eq("id", tracker.id);
    setTrackers((prev) => prev.filter((t) => t.id !== tracker.id));
    setRegions((prev) => {
      const next = { ...prev };
      delete next[tracker.field];
      return next;
    });
    setReadings((prev) => {
      const next = { ...prev };
      delete next[tracker.field];
      return next;
    });
    if (calibratingField === tracker.field) {
      setCalibratingField(null);
      setDraftBox(null);
    }
  }

  const [trackerLabelDrafts, setTrackerLabelDrafts] = useState<Record<string, string>>({});
  async function renameTracker(tracker: Tracker, newLabel: string) {
    const label = newLabel.trim();
    if (!label || label === tracker.label) return;
    await supabase.from("capture_regions").update({ label }).eq("id", tracker.id);
    setTrackers((prev) => prev.map((t) => (t.id === tracker.id ? { ...t, label } : t)));
    setTrackerLabelDrafts((prev) => {
      const next = { ...prev };
      delete next[tracker.id];
      return next;
    });
  }

  // Shrinks/shifts a box so it never sticks out of the given area — used
  // to enforce "trackers always stay inside the captured area" at every
  // save point (manual drag, auto-place, template apply) rather than just
  // during the drag gesture itself, so it can't be bypassed. A no-op when
  // area is null (no captured area drawn — today's unconstrained behavior).
  function clampBoxToArea(box: RegionBox, area: RegionBox | null): RegionBox {
    if (!area) return box;
    const wPct = Math.min(box.wPct, area.wPct);
    const hPct = Math.min(box.hPct, area.hPct);
    const xPct = Math.min(Math.max(box.xPct, area.xPct), area.xPct + area.wPct - wPct);
    const yPct = Math.min(Math.max(box.yPct, area.yPct), area.yPct + area.hPct - hPct);
    return { xPct, yPct, wPct, hPct };
  }

  // Inverse of clampBoxToArea's coordinate space: the AI layout screenshot
  // (see suggestLayoutFromScreenshot) is cropped to captureArea before
  // being sent off (cropVideoToEmbed(video, captureArea)), so every
  // percentage the model returns is relative to THAT sub-frame, not the
  // full captured video — this composes it back to full-frame percentages
  // (same math as the old toFullFramePct, just against captureArea
  // instead of the always-null embedFrame) before it's stored as a real
  // tracker region. A no-op when no captured area is set, since the
  // screenshot was the full frame in that case.
  function composeFromCaptureArea(box: RegionBox, area: RegionBox | null): RegionBox {
    if (!area) return box;
    return {
      xPct: area.xPct + (box.xPct / 100) * area.wPct,
      yPct: area.yPct + (box.yPct / 100) * area.hPct,
      wPct: (box.wPct / 100) * area.wPct,
      hPct: (box.hPct / 100) * area.hPct,
    };
  }

  async function saveRegion(field: string, box: RegionBox) {
    const clamped = clampBoxToArea(box, captureArea);
    setRegions((prev) => ({ ...prev, [field]: clamped }));
    const tracker = trackers.find((t) => t.field === field);
    if (!tracker) return;
    await supabase
      .from("capture_regions")
      .update({ x_pct: clamped.xPct, y_pct: clamped.yPct, w_pct: clamped.wPct, h_pct: clamped.hPct })
      .eq("id", tracker.id);
  }
  async function clearRegionCoords(field: string) {
    setRegions((prev) => ({ ...prev, [field]: null }));
    setReadings((prev) => ({ ...prev, [field]: "" }));
    const tracker = trackers.find((t) => t.field === field);
    if (!tracker) return;
    await supabase.from("capture_regions").update({ x_pct: null, y_pct: null, w_pct: null, h_pct: null }).eq("id", tracker.id);
  }

  // Full-screen's draw-then-pick flow needs one round trip, not two —
  // inserting the tracker row WITH its coordinates already set, instead of
  // addTracker() followed by a separate saveRegion() call that would read
  // back from `trackers` state before the just-added row has landed there.
  async function addTrackerWithRegion(phase: string, category: TrackerCategory, field: string, label: string, box: RegionBox) {
    const clamped = clampBoxToArea(box, captureArea);
    const { data, error } = await supabase
      .from("capture_regions")
      .insert({ match_id: matchId, phase, category, field, label, x_pct: clamped.xPct, y_pct: clamped.yPct, w_pct: clamped.wPct, h_pct: clamped.hPct })
      .select("id")
      .single();
    if (error || !data) {
      setError(error?.message.includes("duplicate key") ? `"${label}" is already tracked for this phase.` : error?.message ?? "Failed to add tracker");
      return;
    }
    setTrackers((prev) => [...prev, { id: data.id, phase, category, field, label }]);
    setRegions((prev) => ({ ...prev, [field]: clamped }));
  }

  // ── Auto-placed default trackers (standard MLBB broadcast layout) ────
  // Sensible percentage-based starting positions for every GAME_STARTED
  // tracker, based on how MLBB tournament broadcasts consistently lay out
  // their HUD: net worth in the far top corners, the game clock top-center,
  // each team's kill/tower/lord/turtle counts in a small cluster just below
  // their team name near top-center, five KDA rows down each side edge
  // (one per player portrait), and the kill-streak banner region roughly
  // center screen. Purely a starting point — every box below is exactly as
  // draggable/resizable afterward as one placed by hand, since this writes
  // the same capture_regions rows the manual flow does (see
  // autoPlaceDefaultTrackers). Broadcast overlays vary slightly tournament
  // to tournament, so these are deliberately generous boxes meant to be
  // nudged, not pixel-exact crops.
  function defaultTrackerLayout(): { category: TrackerCategory; field: string; label: string; box: RegionBox }[] {
    const items: { category: TrackerCategory; field: string; label: string; box: RegionBox }[] = [];
    items.push({ category: "net_worth", field: "net_worth_left", label: "Net worth — Left", box: { xPct: 1, yPct: 1, wPct: 11, hPct: 4.5 } });
    items.push({ category: "net_worth", field: "net_worth_right", label: "Net worth — Right", box: { xPct: 88, yPct: 1, wPct: 11, hPct: 4.5 } });
    items.push({ category: "game_timer", field: "game_timer", label: "Game timer", box: { xPct: 45, yPct: 1, wPct: 10, hPct: 4.5 } });
    // Team kills + tower/lord/turtle counts sit as a small horizontal
    // cluster just below the team name, left cluster hugging center-left
    // and right cluster hugging center-right of the top-center HUD.
    const objectiveCluster: { type: string; dx: number }[] = [
      { type: "kills", dx: 0 },
      { type: "tower", dx: 5.5 },
      { type: "lord", dx: 11 },
      { type: "turtle", dx: 16.5 },
    ];
    for (const side of SIDES) {
      const baseX = side.key === "left" ? 24 : 56;
      for (const { type, dx } of objectiveCluster) {
        const x = side.key === "left" ? baseX + dx : baseX + (16.5 - dx);
        if (type === "kills") {
          items.push({ category: "team_kills", field: `team_kills_${side.key}`, label: `Team kills — ${side.label}`, box: { xPct: x, yPct: 6, wPct: 4.5, hPct: 3.5 } });
        } else {
          items.push({
            category: "objective",
            field: `objective_${side.key}_${type}`,
            label: `Objective — ${side.label} ${type[0].toUpperCase()}${type.slice(1)}`,
            box: { xPct: x, yPct: 6, wPct: 4.5, hPct: 3.5 },
          });
        }
      }
    }
    // Ten KDA regions, five down each edge — evenly spaced top-to-bottom
    // under where each player's portrait renders on a standard overlay.
    for (const side of SIDES) {
      const x = side.key === "left" ? 1 : 84;
      for (let n = 1; n <= 5; n++) {
        const y = 14 + (n - 1) * 12;
        items.push({
          category: "player_kda",
          field: `player_kda_${side.key}_${n}`,
          label: `K/D/A — ${side.label} #${n} (${KDA_SLOT_LABELS[n - 1]})`,
          box: { xPct: x, yPct: y, wPct: 15, hPct: 6 },
        });
      }
    }
    items.push({ category: "kill_banner", field: "kill_banner", label: "Kill banner (SAVAGE/MANIAC/etc.)", box: { xPct: 32, yPct: 42, wPct: 36, hPct: 10 } });
    return items;
  }
  const [autoPlacingTrackers, setAutoPlacingTrackers] = useState(false);
  // Only ever fills in whatever's missing — a field that's already tracked
  // (whether from a previous auto-place, a tournament default, or a manual
  // placement) is left completely alone, so this is safe to re-run any
  // time as a "restore anything I deleted back to a sane starting point"
  // action, not just a first-run-only migration.
  async function autoPlaceDefaultTrackers() {
    setAutoPlacingTrackers(true);
    try {
      const existingGameStarted = new Set(trackers.filter((t) => t.phase === "GAME_STARTED").map((t) => t.field));
      const missing = defaultTrackerLayout().filter((item) => !existingGameStarted.has(item.field));
      for (const item of missing) {
        await addTrackerWithRegion("GAME_STARTED", item.category, item.field, item.label, item.box);
      }
    } finally {
      setAutoPlacingTrackers(false);
    }
  }
  // ── Named tracker templates ────────────────────────────────────────
  // defaultTrackerLayout() above is one hardcoded guess at a "standard"
  // MLBB broadcast layout — real broadcasts vary tournament to
  // tournament. This lets an admin save whatever they've actually
  // calibrated (fully or partially) under a name, then apply that same
  // layout to any other match instead of nudging every box by hand again.
  // capture_regions rows with template_name set (match_id/tournament_id
  // both null) are the third scope alongside the existing per-match and
  // per-tournament-default rows.
  type TrackerTemplate = { name: string; regionCount: number };
  const [trackerTemplates, setTrackerTemplates] = useState<TrackerTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [savingTemplateAs, setSavingTemplateAs] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [selectedTrackerTemplate, setSelectedTrackerTemplate] = useState("");
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [renamingTemplate, setRenamingTemplate] = useState(false);
  const [deletingTemplate, setDeletingTemplate] = useState(false);

  const loadTrackerTemplates = useCallback(async () => {
    const { data } = await supabase.from("capture_regions").select("template_name").not("template_name", "is", null);
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const name = (row as { template_name: string }).template_name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    setTrackerTemplates(Array.from(counts, ([name, regionCount]) => ({ name, regionCount })).sort((a, b) => a.name.localeCompare(b.name)));
    setTemplatesLoaded(true);
  }, []);
  useEffect(() => {
    loadTrackerTemplates();
  }, [loadTrackerTemplates]);

  // Saves every currently-calibrated region (any phase, not just
  // GAME_STARTED — a real template should carry the draft/technical-pause
  // layouts too) under the given name. Upserts per field, so re-saving
  // under the same name after recalibrating a few boxes just updates
  // those rows rather than erroring on the unique index.
  async function saveTrackersAsTemplate(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSavingTemplateAs(true);
    try {
      const rows = trackers
        .filter((t) => regions[t.field])
        .map((t) => {
          const box = regions[t.field]!;
          return {
            template_name: trimmed,
            phase: t.phase,
            category: t.category,
            field: t.field,
            label: t.label,
            x_pct: box.xPct,
            y_pct: box.yPct,
            w_pct: box.wPct,
            h_pct: box.hPct,
          };
        });
      if (rows.length === 0) return;
      await supabase.from("capture_regions").upsert(rows, { onConflict: "template_name,phase,field" });
      setNewTemplateName("");
      await loadTrackerTemplates();
    } finally {
      setSavingTemplateAs(false);
    }
  }

  // Same "only ever fills in whatever's missing" contract as
  // autoPlaceDefaultTrackers — applying a template never overwrites a
  // tracker/region that's already there, across every phase the template
  // covers, not just GAME_STARTED.
  async function applyTrackerTemplate(name: string) {
    if (!name) return;
    setApplyingTemplate(true);
    try {
      const { data } = await supabase
        .from("capture_regions")
        .select("phase, category, field, label, x_pct, y_pct, w_pct, h_pct")
        .eq("template_name", name);
      for (const row of data ?? []) {
        const r = row as { phase: string; category: TrackerCategory; field: string; label: string; x_pct: number; y_pct: number; w_pct: number; h_pct: number };
        if (trackers.some((t) => t.phase === r.phase && t.field === r.field)) continue;
        await addTrackerWithRegion(r.phase, r.category, r.field, r.label, { xPct: r.x_pct, yPct: r.y_pct, wPct: r.w_pct, hPct: r.h_pct });
      }
    } finally {
      setApplyingTemplate(false);
    }
  }

  // Renames a template in place — every row under the old template_name
  // becomes the new one, so matches that already applied it are
  // unaffected (they got their own capture_regions rows at apply time;
  // template rows are only ever a source to copy from, never referenced
  // live). Blocks on a name collision instead of silently merging two
  // templates together.
  async function renameTrackerTemplate(oldName: string) {
    if (!oldName) return;
    const newName = prompt(`Rename template "${oldName}" to:`, oldName)?.trim();
    if (!newName || newName === oldName) return;
    if (trackerTemplates.some((t) => t.name === newName)) {
      setError(`A template named "${newName}" already exists.`);
      return;
    }
    setRenamingTemplate(true);
    try {
      const { error } = await supabase.from("capture_regions").update({ template_name: newName }).eq("template_name", oldName);
      if (error) {
        setError(error.message);
        return;
      }
      if (selectedTrackerTemplate === oldName) setSelectedTrackerTemplate(newName);
      await loadTrackerTemplates();
    } finally {
      setRenamingTemplate(false);
    }
  }

  async function deleteTrackerTemplate(name: string) {
    if (!name) return;
    if (!confirm(`Delete template "${name}"? Matches that already applied it keep their trackers — this only removes it from the list.`)) return;
    setDeletingTemplate(true);
    try {
      const { error } = await supabase.from("capture_regions").delete().eq("template_name", name);
      if (error) {
        setError(error.message);
        return;
      }
      if (selectedTrackerTemplate === name) setSelectedTrackerTemplate("");
      await loadTrackerTemplates();
    } finally {
      setDeletingTemplate(false);
    }
  }

  // Fires once per match, the first time it has zero GAME_STARTED trackers
  // after the tournament-defaults/match-regions load effect has actually
  // resolved (trackersLoaded guards against firing on the transient empty
  // state before that fetch returns) — gives every match a populated
  // starting layout automatically instead of an empty canvas, without ever
  // clobbering a match that already has its own trackers (tournament
  // default or manual) configured.
  const autoPlacedForMatch = useRef<string | null>(null);
  useEffect(() => {
    if (!trackersLoaded || !matchId || !match) return;
    if (autoPlacedForMatch.current === matchId) return;
    if (trackers.some((t) => t.phase === "GAME_STARTED")) {
      autoPlacedForMatch.current = matchId; // already has some — never auto-place over it
      return;
    }
    autoPlacedForMatch.current = matchId;
    autoPlaceDefaultTrackers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackersLoaded, matchId, match?.id]);

  // Same "already tracked" filter as trackerCatalogOptions, just
  // parameterized by the slide-anywhere picker's own phase pick instead of
  // the inline Add-tracker row's phase state — the two panels are
  // independent UI, same underlying catalog.
  const pendingBoxOptions = catalogForPhase(pendingBoxPhase).filter(
    (opt) => !trackers.some((t) => t.phase === pendingBoxPhase && t.field === opt.field)
  );
  async function savePendingBox() {
    if (!pendingBox) return;
    const opt = pendingBoxOptions.find((o) => o.field === pendingBoxField);
    if (!opt) return;
    const existing = trackers.find((t) => t.phase === pendingBoxPhase && t.field === opt.field);
    if (existing) await saveRegion(opt.field, pendingBox);
    else await addTrackerWithRegion(pendingBoxPhase, opt.category, opt.field, opt.label, pendingBox);
    setPendingBox(null);
    setPendingBoxPhase("");
    setPendingBoxField("");
  }
  function cancelPendingBox() {
    setPendingBox(null);
    setPendingBoxPhase("");
    setPendingBoxField("");
  }

  const [savedDefaultField, setSavedDefaultField] = useState<string | null>(null);
  async function saveRegionAsTournamentDefault(tracker: Tracker) {
    const box = regions[tracker.field];
    if (!box || !match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      {
        tournament_id: match.tournament_id,
        phase: tracker.phase,
        category: tracker.category,
        field: tracker.field,
        label: tracker.label,
        x_pct: box.xPct,
        y_pct: box.yPct,
        w_pct: box.wPct,
        h_pct: box.hPct,
      },
      { onConflict: "tournament_id,phase,field" }
    );
    setSavedDefaultField(tracker.field);
    setTimeout(() => setSavedDefaultField(null), 2000);
  }

  async function saveOverlayHint() {
    if (!matchId) return;
    await supabase.from("capture_regions").upsert(
      { match_id: matchId, phase: "ANY", category: "overlay_hint", field: "overlay_hint", label: "Overlay hint", hint_text: overlayHint || null },
      { onConflict: "match_id,phase,field" }
    );
  }

  // null clears it (see clearCaptureArea) — every existing tracker region
  // is left exactly where it is when that happens, only future saves stop
  // being constrained.
  async function saveCaptureArea(box: RegionBox | null) {
    setCaptureArea(box);
    if (!matchId) return;
    await supabase.from("capture_regions").upsert(
      {
        match_id: matchId,
        phase: "ANY",
        category: "capture_area",
        field: "__capture_area__",
        label: "Captured area",
        x_pct: box?.xPct ?? null,
        y_pct: box?.yPct ?? null,
        w_pct: box?.wPct ?? null,
        h_pct: box?.hPct ?? null,
      },
      { onConflict: "match_id,phase,field" }
    );
  }

  const [overlayHintSavedAsDefault, setOverlayHintSavedAsDefault] = useState(false);
  async function saveOverlayHintAsTournamentDefault() {
    if (!match?.tournament_id) return;
    await supabase.from("capture_regions").upsert(
      { tournament_id: match.tournament_id, phase: "ANY", category: "overlay_hint", field: "overlay_hint", label: "Overlay hint", hint_text: overlayHint || null },
      { onConflict: "tournament_id,phase,field" }
    );
    setOverlayHintSavedAsDefault(true);
    setTimeout(() => setOverlayHintSavedAsDefault(false), 2000);
  }

  // Composes a region drawn relative to the embed (0-100% of the
  // livestream iframe's own rect — what calibration actually works
  // against now) with where that embed sits inside the full captured tab
  // frame, producing the box cropCanvasFor needs (0-100% of the whole
  // frame, since that's all `video` itself knows about). Falls back to
  // the box unchanged when embedFrame isn't known — e.g. no embeddable
  // stream URL — which reproduces the old whole-tab-relative behavior for
  // those matches instead of cropping to nothing.
  function toFullFramePct(box: RegionBox, frame: EmbedFrame | null): RegionBox {
    if (!frame) return box;
    return {
      xPct: frame.xPct + (box.xPct / 100) * frame.wPct,
      yPct: frame.yPct + (box.yPct / 100) * frame.hPct,
      wPct: (box.wPct / 100) * frame.wPct,
      hPct: (box.hPct / 100) * frame.hPct,
    };
  }

  // Same idea as cropCanvasFor but for the "grab the whole frame" paths
  // (moment screenshots, share cards, AI full-frame capture) — these want
  // a plain color crop of just the livestream, not a single grayscale OCR
  // region, so it's a separate small helper rather than routing through
  // cropCanvasFor's grayscale filter. Falls back to the full raw frame
  // (today's behavior) when embedFrame isn't known.
  function cropVideoToEmbed(video: HTMLVideoElement, frame: EmbedFrame | null): HTMLCanvasElement | null {
    if (video.videoWidth === 0) return null;
    if (!frame) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      return canvas;
    }
    const cx = (frame.xPct / 100) * video.videoWidth;
    const cy = (frame.yPct / 100) * video.videoHeight;
    const cw = (frame.wPct / 100) * video.videoWidth;
    const ch = (frame.hPct / 100) * video.videoHeight;
    if (cw < 5 || ch < 5) return null;
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext("2d")?.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);
    return canvas;
  }

  function cropCanvasFor(video: HTMLVideoElement, box: RegionBox) {
    const cx = (box.xPct / 100) * video.videoWidth;
    const cy = (box.yPct / 100) * video.videoHeight;
    const cw = (box.wPct / 100) * video.videoWidth;
    const ch = (box.hPct / 100) * video.videoHeight;
    if (cw < 5 || ch < 5) return null;

    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    full.getContext("2d")?.drawImage(video, 0, 0);

    const crop = document.createElement("canvas");
    crop.width = cw;
    crop.height = ch;
    const cropCtx = crop.getContext("2d");
    // Grayscale before Tesseract sees it — broadcast overlays are almost
    // always light text on a dark translucent panel (or vice versa); color
    // noise (team colors bleeding through the panel, chroma compression
    // artifacts) doesn't carry any digit/letter information and Tesseract's
    // own internal binarization does better starting from a flat luminance
    // image than from full color.
    if (cropCtx) cropCtx.filter = "grayscale(1)";
    cropCtx?.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
    return crop;
  }

  // Persists the full mm:ss reading (not just the minute used for
  // minute_mark on logged events) so the public page can show a real
  // running game clock instead of only updating once per admin action.
  // Client-side ticking (in the public page) fills the gap between these
  // writes, using current_time_updated_at as the anchor.
  const lastPersistedSeconds = useRef<number | null>(null);
  // Reset whenever the game currently being tracked changes (Game 1
  // finishes, Game 2 starts) — this is the never-decreases guard's memory
  // of the last game-clock reading: left unreset, Game 2 starting back
  // near 00:00 would look like a garbled decrease against Game 1's final
  // ~20:00+ reading and get permanently rejected forever — "a new game is
  // detected" (the validation spec's explicit exception to
  // never-decreases) has to mean something, and a new game.id is exactly
  // that signal.
  useEffect(() => {
    lastPersistedSeconds.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id]);
  async function updateGameClock(mm: number, ss: number) {
    if (!game) return;
    const totalSeconds = mm * 60 + ss;
    if (totalSeconds === lastPersistedSeconds.current) return;
    lastPersistedSeconds.current = totalSeconds;
    await supabase
      .from("games")
      .update({ current_time_seconds: totalSeconds, current_time_updated_at: new Date().toISOString() })
      .eq("id", game.id);
  }

  // ── Manual stopwatch (OCR fallback) ──────────────────────────────────
  // Same anchor-based ticking idea as the OCR clock above: manual_time_seconds
  // is the last value the admin set, manual_time_started_at is when the
  // stopwatch was (re)started from that value, and both the admin console
  // and the public page compute "now" by adding elapsed real time on top —
  // no per-second write loop needed while it's just running.
  function manualElapsedSeconds(g: Game): number {
    if (!g.manual_time_running || !g.manual_time_started_at) return g.manual_time_seconds ?? 0;
    return (g.manual_time_seconds ?? 0) + Math.floor((Date.now() - new Date(g.manual_time_started_at).getTime()) / 1000);
  }
  async function startManualClock() {
    if (!game) return;
    await supabase
      .from("games")
      .update({ manual_time_running: true, manual_time_started_at: new Date().toISOString(), manual_time_seconds: manualElapsedSeconds(game) })
      .eq("id", game.id);
    loadAll();
  }
  async function pauseManualClock() {
    if (!game) return;
    await supabase
      .from("games")
      .update({ manual_time_running: false, manual_time_seconds: manualElapsedSeconds(game), manual_time_started_at: null })
      .eq("id", game.id);
    loadAll();
  }
  async function setManualClockSeconds(totalSeconds: number) {
    if (!game) return;
    await supabase
      .from("games")
      .update({
        manual_time_seconds: Math.max(0, totalSeconds),
        manual_time_started_at: game.manual_time_running ? new Date().toISOString() : null,
      })
      .eq("id", game.id);
    loadAll();
  }
  async function adjustManualClock(deltaSeconds: number) {
    if (!game) return;
    await setManualClockSeconds(manualElapsedSeconds(game) + deltaSeconds);
  }
  async function setClockSource(source: "ocr" | "manual") {
    if (!game) return;
    await supabase.from("games").update({ clock_source: source }).eq("id", game.id);
    loadAll();
  }

  // Keeps `minute` (used for minute_mark on every logged action) following
  // whichever clock source is active — replaces the old manual number
  // input entirely. captureTick() already calls setMinute() on every OCR
  // read while capture is actively running; this covers the gaps: the
  // manual-stopwatch source at all times, and the OCR source's persisted
  // value (current_time_seconds/_updated_at) for whenever capture isn't
  // actively running (paused, not yet started) so minute doesn't just sit
  // stale at whatever it last was.
  useEffect(() => {
    if (!game) return;
    if (game.clock_source === "manual") {
      const tick = () => {
        const s = manualElapsedSeconds(game);
        setMinute(Math.floor(s / 60));
        setSecondOfMinute(s % 60);
      };
      tick();
      if (!game.manual_time_running) return;
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
    if (captureActive) return; // captureTick() owns it while actively reading
    if (game.current_time_seconds == null || !game.current_time_updated_at) return;
    const elapsed = Math.floor((Date.now() - new Date(game.current_time_updated_at).getTime()) / 1000);
    const totalSeconds = game.current_time_seconds + elapsed;
    setMinute(Math.floor(totalSeconds / 60));
    setSecondOfMinute(totalSeconds % 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    game?.id,
    game?.clock_source,
    game?.manual_time_running,
    game?.manual_time_seconds,
    game?.manual_time_started_at,
    game?.current_time_seconds,
    game?.current_time_updated_at,
    captureActive,
  ]);

  // Same pattern as updateGameClock but for the two other phase-scoped
  // clocks — Waiting's pre-game countdown and Draft's per-team pick timer —
  // each on its own last-persisted guard so the three never clobber one
  // another's dedup state.
  const lastPersistedCountdown = useRef<number | null>(null);
  async function updateCountdown(mm: number, ss: number) {
    if (!match) return;
    const totalSeconds = mm * 60 + ss;
    if (totalSeconds === lastPersistedCountdown.current) return;
    lastPersistedCountdown.current = totalSeconds;
    await supabase
      .from("matches")
      .update({ countdown_seconds: totalSeconds, countdown_updated_at: new Date().toISOString() })
      .eq("id", match.id);
  }

  // Manual fallback for the countdown field — a one-way countdown the
  // public page already decays client-side from a single (value,
  // updated_at) pair, so unlike the game clock this doesn't need a
  // running/paused state machine, just a way to set the starting value
  // when OCR hasn't been calibrated yet or the overlay text isn't legible.
  // Draft timers (draft_timer_a_seconds/b_seconds) used to have the exact
  // same manual-set + OCR-tick plumbing here — removed per product
  // decision to drop draft timers from this console entirely (the DB
  // columns stay; nothing here writes to them anymore, and the
  // draft_timer tracker category has no catalog entry or capture-tick
  // handler left to drive it).
  function parseMmSs(input: string): number | null {
    const m = input.trim().match(/^(\d{1,3}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  async function setManualCountdown(input: string) {
    const totalSeconds = parseMmSs(input);
    if (totalSeconds == null) return;
    lastPersistedCountdown.current = totalSeconds;
    await supabase
      .from("matches")
      .update({ countdown_seconds: totalSeconds, countdown_updated_at: new Date().toISOString() })
      .eq("id", match?.id);
  }

  function guessWinnerFromText(text: string): string | null {
    const n = normalize(text);
    if (match?.team_a && n.includes(normalize(match.team_a.name))) return match.team_a.id;
    if (match?.team_b && n.includes(normalize(match.team_b.name))) return match.team_b.id;
    return null;
  }

  // The one auto phase-detection this local-OCR system attempts: a
  // readable in-game timer is a strong, text-based signal (unlike
  // pick/ban icons, which this console deliberately never tries to OCR —
  // see the note in the capture section below) that the game has moved
  // past the draft screen. Fires once per game.
  async function maybeAutoStartGame() {
    if (!match || !game) return;
    if (autoStartedGameId.current === game.id) return;
    if (match.state === "GAME_STARTED" || match.state === "GAME_FINISHED" || match.state === "SERIES_FINISHED") return;
    autoStartedGameId.current = game.id;
    const { error } = await supabase.from("matches").update({ state: "GAME_STARTED" }).eq("id", match.id);
    if (error) console.error("Failed to auto-set GAME_STARTED:", error.message);
    else loadAll();
  }

  // Deterministic per-slot player resolution — a draft_hero_pick or
  // player_kda tracker's own (side, slot) already says which roster
  // position it is (same role order KDA_SLOT_LABELS/teamPlayers uses
  // everywhere else), so identity no longer depends on fuzzy-matching a
  // player name out of the OCR text — only the hero name (or K/D/A digits)
  // needs to be legible in that crop.
  function slotPlayer(side: Side, slot: number): Player | null {
    const teamId = side === "left" ? resolveLeftTeamId() : resolveRightTeamId();
    if (!teamId) return null;
    // is_active_roster — same reasoning as lockInPositionalPicks/
    // draftFullyResolved: without this filter an OCR-read K/D/A update for
    // "slot 3" could resolve to a bench player instead of the actual
    // starter in that role, silently creating a stat row for a substitute
    // who was never part of this game.
    const teamPlayers = players.filter((p) => p.team_id === teamId && p.is_active_roster).sort((a, b) => roleIndex(a.role) - roleIndex(b.role));
    return teamPlayers[slot - 1] ?? null;
  }
  function findHeroInText(text: string) {
    const n = normalize(text);
    return heroes.find((h) => n.includes(normalize(h.name))) ?? null;
  }
  // MLBB's broadcast overlay shows net worth as a plain digit string with
  // no on-screen decimal point or "K" — the last digit read is always the
  // tenths-of-a-thousand place ("55" -> 5.5K -> 5500 gold stored, "341" ->
  // 34.1K -> 34100 gold stored). A read below that 2-digit minimum is a
  // dropped digit, not a genuine sub-1K net worth this deep into a draft
  // that's already past pick/ban — treated as unreadable rather than
  // risking a wildly wrong value landing (net_worth's OCR whitelist is
  // digits + "." only, so an explicit decimal is still handled directly
  // for whichever source — e.g. AI vision mode — supplies one).
  function parseGoldText(text: string): number | null {
    const cleaned = text.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    if (cleaned.includes(".")) {
      const n = Number(cleaned);
      return Number.isFinite(n) ? Math.round(n * 1000) : null;
    }
    if (cleaned.length < 2) return null;
    return Number(cleaned) * 100;
  }
  function formatGold(n: number): string {
    return `${(n / 1000).toFixed(1)}K`;
  }
  // Only a slash-separated "K/D/A" counts now — the previous "any other
  // single-character separator" fallback was exactly the kind of
  // non-numeric-character tolerance that risked misreads; "/" is the only
  // punctuation this shape is allowed. Cleaned to digits + "/" first.
  function parseKda(text: string): { kills: number; deaths: number; assists: number } | null {
    const cleaned = text.replace(/[^0-9/]/g, "");
    const slash = cleaned.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!slash) return null;
    return { kills: Number(slash[1]), deaths: Number(slash[2]), assists: Number(slash[3]) };
  }
  // The "kda_group" combined tracker's whole point: one region spanning
  // all 5 KDA rows, one OCR pass, split back into 5 readings by line. Only
  // a real "N/N/N" line counts — anything else on the same line (a spell
  // cooldown digit, a partial/garbled row) simply doesn't match the shape
  // and is dropped rather than guessed at, exactly the "ignore it if it
  // doesn't follow x/x/x" behavior asked for. Order in, order out: relies
  // entirely on Tesseract preserving top-to-bottom line order, which is
  // what a role-ordered column of rows naturally OCRs as.
  function parseKdaGroupLines(text: string): { kills: number; deaths: number; assists: number }[] {
    return text
      .split(/\n+/)
      .map((line) => parseKda(line))
      .filter((k): k is { kills: number; deaths: number; assists: number } => k !== null);
  }
  // The "objectives_group" combined tracker's equivalent: one region
  // spanning the tower/lord/turtle icon cluster, digit-only OCR (icons
  // themselves are images, never text, so they can't appear in the
  // output — only the 3 numbers next to them can). Every digit run found,
  // in reading order. Deliberately does NOT try to cope with a partial
  // read (2 numbers instead of 3, a run split by OCR into two) — the
  // caller requires exactly 3 or skips the tick entirely, since a
  // miscounted split would silently misassign which number is which
  // objective type.
  function parseObjectivesGroupCounts(text: string): number[] {
    return (text.match(/\d+/g) ?? []).map(Number);
  }
  // Domain-rule gate for OCR-automatic objective reads only — manual
  // clicks (incrementObjective called directly) always bypass this, same
  // as every other manual-override path in this file: an admin correcting
  // a genuine misread needs to be able to enter a value this heuristic
  // itself would reject. Returns the highest count this tick should
  // actually advance to (clamped, not a hard reject), so a correct-but-
  // partial read still lands instead of the whole tick being discarded.
  // The on-screen game timer an OCR tick reads can lag the actual game
  // clock by a few seconds — every spawn-timing gate below allows this
  // much slack before treating a read as "too early to be real" rather
  // than rejecting a genuine, just-slightly-early reading.
  const OCR_TIMING_TOLERANCE_SECONDS = 5;
  function plausibleObjectiveTarget(teamId: string, type: string, rawTarget: number): number {
    const current = objectiveCount(teamId, type);
    if (rawTarget <= current) return rawTarget; // never-decreases is already enforced by the caller's loop bound
    const gameClockSeconds = minute * 60 + secondOfMinute;
    // Turtle: first spawn exactly 2:00, no genuine turtle-take reading is
    // possible before that. At most 4 spawn/kill cycles exist across the
    // whole match (shared by both teams), and once a turtle survives past
    // ~6:00 it stops respawning as a turtle at all — it's the one that
    // transitions into an early Lord instead, so no further turtle takes
    // are legitimate after that point.
    if (type === "turtle") {
      if (gameClockSeconds < 120 - OCR_TIMING_TOLERANCE_SECONDS) return current;
      if (totalObjectiveCount("turtle") >= 4) return current;
      const lastKillSeconds = lastObjectiveSeconds("turtle");
      if (lastKillSeconds != null && lastKillSeconds > 360) return current;
      return rawTarget;
    }
    // Lord: first spawn 8:00 (a Turtle left alone from ~8:00-9:00
    // transforms into an early Lord, but that's still not reachable before
    // 8:00 either way). Once killed, the next Lord takes exactly 3
    // minutes to respawn — a read claiming another kill sooner than that
    // is reading a stale banner/number, not a real one.
    if (type === "lord") {
      if (gameClockSeconds < 480 - OCR_TIMING_TOLERANCE_SECONDS) return current;
      const lastKillSeconds = lastObjectiveSeconds("lord");
      if (lastKillSeconds != null && gameClockSeconds < lastKillSeconds + 180 - OCR_TIMING_TOLERANCE_SECONDS) return current;
      return rawTarget;
    }
    if (type === "tower") {
      // 9 enemy towers per team, hard cap — never a real read past that.
      const capped = Math.min(rawTarget, 9);
      // "Can only destroy a maximum of 3 towers simultaneously, then a
      // window before the 4th" — a single reading jumping the count by
      // more than 3 in one tick is far more likely an OCR digit misread
      // than four-plus towers actually falling in one 5s capture tick.
      // Clamped to +3 rather than rejected outright, so a real (if fast)
      // multi-tower push still lands the plausible portion.
      return Math.min(capped, current + 3);
    }
    return rawTarget;
  }

  async function applySingleObjectiveReading(
    teamId: string,
    type: string,
    text: string,
    field: string,
    label: string,
    confidence: number | null
  ) {
    const n = text.match(/\d+/);
    if (!n) return;
    const rawTarget = Number(n[0]);
    const target = plausibleObjectiveTarget(teamId, type, rawTarget);
    const current = objectiveCount(teamId, type);
    // An admin correction is still within its cooldown window — hold this
    // read back as a flag instead of auto-applying it, even though the
    // spawn-timing/cap guard above would otherwise consider it plausible.
    if (target > current && withinManualObjectiveCooldown(teamId, type)) {
      flagReading(field, {
        label,
        raw: text,
        confidence,
        reason: `Read ${rawTarget} (${target} after guards), but this count was just corrected manually — confirm to apply it anyway`,
        apply: async () => {
          const c = objectiveCount(teamId, type);
          for (let i = c; i < target; i++) await incrementObjective(teamId, type);
        },
      });
      return;
    }
    for (let i = current; i < target; i++) await incrementObjective(teamId, type);
    // The heuristic clamped this read down (spawn timing, tower cap/pace)
    // — surface the full raw reading instead of silently dropping it, in
    // case it's actually right (a genuinely fast multi-tower push, a
    // timing edge case).
    if (target < rawTarget) {
      flagReading(field, {
        label,
        raw: text,
        confidence,
        reason: `Read ${rawTarget}, only applied up to ${target} (spawn timing/cap guard) — confirm to apply the full reading`,
        apply: async () => {
          const c = objectiveCount(teamId, type);
          for (let i = c; i < rawTarget; i++) await incrementObjective(teamId, type);
        },
      });
    }
  }

  // Direct correction, either direction — the +/- buttons only ever move
  // one at a time, which is fine for logging live but slow for fixing a
  // count that's drifted (a missed OCR tick, a double-click).
  //
  // Increasing reuses incrementObjective in a loop — each call is a plain
  // insert that doesn't depend on reading back what the previous call did,
  // so looping it with await is safe.
  //
  // Decreasing does NOT reuse decrementObjective in a loop (that was the
  // actual bug behind "force-changing the value does nothing" on the
  // Objectives tab): decrementObjective computes "the most recent row" by
  // reading the `objectives` React-state array, but that array only
  // updates once loadAll()'s async refetch resolves — well after this
  // function's while-loop has already fired off its next iteration. Every
  // iteration in the same batch was reading the exact same stale array,
  // so each one recomputed the identical "most recent" row: the first
  // delete succeeded, every delete after it matched zero rows (already
  // gone) and returned no error, so a correction like 4→1 only ever
  // actually removed one objective no matter how many the admin typed.
  // Fixed by computing the whole batch of rows to remove from a single
  // snapshot up front, then deleting them all in one request.
  async function setObjectiveCount(teamId: string, type: string, target: number) {
    const clamped = Math.max(0, Math.round(target));
    const current = objectiveCount(teamId, type);
    markManualObjectiveEdit(teamId, type);
    if (clamped > current) {
      for (let i = current; i < clamped; i++) await incrementObjective(teamId, type);
      return;
    }
    if (clamped === current) return;
    const toRemove = objectives
      .filter((o) => o.team_id === teamId && o.type === type)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, current - clamped);
    if (toRemove.length === 0) return;
    const ids = toRemove.map((o) => o.id);
    if (isContributor) {
      for (const row of toRemove) {
        pushPendingEdit({ table: "objectives", action: "delete", before: row as unknown as Record<string, unknown>, after: null });
      }
      setObjectives((prev) => prev.filter((o) => !ids.includes(o.id)));
      return;
    }
    const { error } = await supabase.from("objectives").delete().in("id", ids);
    if (error) {
      setError(error.message);
      return;
    }
    setObjectives((prev) => prev.filter((o) => !ids.includes(o.id)));
    loadAll();
  }

  async function captureTick() {
    const video = previewRef.current;
    const worker = workerRef.current;
    if (!video || !worker || video.videoWidth === 0) return;
    if (tickInFlight.current) return;
    tickInFlight.current = true;
    try {
      await captureTickBody(video, worker);
    } finally {
      tickInFlight.current = false;
    }
  }

  // Every numeric category only ever legitimately contains digits plus one
  // disambiguating separator (K/D/A's "/", net worth's ".", the timer's
  // ":") — constraining what Tesseract is even allowed to output for these
  // categories (tessedit_char_whitelist) cuts off a whole class of misread
  // at the source, rather than post-hoc regex-stripping stray letters/
  // symbols out of free-form OCR text after the fact. Only the categories
  // that genuinely read words (a kill banner's "SAVAGE", a map name, the
  // word "pause") stay unrestricted; null here means "don't touch the
  // worker's charset for this tick."
  function charWhitelistFor(category: string): string | null {
    switch (category) {
      case "player_kda":
      case "kda_group":
        return "0123456789/";
      case "net_worth":
        return "0123456789.";
      case "game_timer":
      case "countdown":
        return "0123456789:";
      case "team_kills":
      case "objective":
      case "objectives_group":
        return "0123456789";
      default:
        return null; // kill_banner, victory_banner, pause_word, map_setting — real words expected
    }
  }

  async function captureTickBody(video: HTMLVideoElement, worker: NonNullable<typeof workerRef.current>) {
    // Hard stop once this game is done — validation-spec golden rule: "after
    // GAME_FINISHED, reject any additional kills/deaths/assists/net worth/
    // objective/turret updates." Phase-scoping (activeTrackers below) gets
    // most of the way there already since GAME_STARTED trackers stop being
    // "active" the moment the admin moves the match off that phase, but
    // that's a step the admin has to actually take — this covers the gap
    // where game.status is already "finished" (Declare Winner clicked) but
    // match.state/trackers haven't been walked forward yet, so a straggling
    // OCR tick can't write a post-game stat.
    if (game?.status === "finished") return;
    // Only scan the trackers configured for whatever phase the admin has
    // this match set to right now — this is what makes each phase's
    // tracker genuinely distinct instead of always reading the same fields
    // regardless of what's actually on screen.
    const activeTrackers = trackers.filter((t) => t.phase === match?.state);
    const leftTeamId = resolveLeftTeamId();
    const rightTeamId = resolveRightTeamId();
    // Collected across the loop and applied once at the end, since both
    // sides of a paired variable (net worth, K/D/A) need to be read before
    // they can be cross-checked or combined into one write.
    let networthLeft: number | null = null;
    let networthRight: number | null = null;
    let networthLeftField: { field: string; label: string; confidence: number | null } | null = null;
    let networthRightField: { field: string; label: string; confidence: number | null } | null = null;
    const kdaParsed: {
      playerId: string;
      heroName: string | null;
      field: string;
      label: string;
      raw: string;
      confidence: number | null;
      kills: number;
      deaths: number;
      assists: number;
    }[] = [];

    for (const tracker of activeTrackers) {
      const box = regions[tracker.field];
      if (!box) continue;
      const canvas = cropCanvasFor(video, toFullFramePct(box, embedFrame));
      if (!canvas) continue;
      const { side, slot, objectiveType } = fieldParts(tracker.field);
      const sideTeamId = side === "left" ? leftTeamId : side === "right" ? rightTeamId : null;

      try {
        // Constrain the worker's output charset to exactly what this
        // category can legitimately contain before reading it — see
        // charWhitelistFor. An empty string clears the constraint for
        // word-reading categories (Tesseract's own "no restriction" value).
        await worker.setParameters({ tessedit_char_whitelist: charWhitelistFor(tracker.category) ?? "" });
        // `data` also carries Tesseract's own overall page-confidence
        // (0-100) for this recognize() call — already computed by
        // tesseract.js on every tick, just wired into trackerHealth below
        // rather than left unread. Purely diagnostic: nothing downstream
        // of this line changes what it did before.
        const { data } = await worker.recognize(canvas);
        const text = data.text;
        const trimmed = text.trim();
        setReadings((prev) => ({ ...prev, [tracker.field]: trimmed }));
        setTrackerHealth((prev) => ({
          ...prev,
          [tracker.field]: {
            lastGoodAt: trimmed ? Date.now() : prev[tracker.field]?.lastGoodAt ?? null,
            confidence: data.confidence,
          },
        }));
        // Numeric tracking only ever needs digits plus whichever single
        // punctuation character disambiguates the number itself (":" for a
        // clock) — everything else OCR picked up (stray glyphs, overlay
        // chrome) is noise that would otherwise corrupt the match.
        const numericOnly = trimmed.replace(/[^0-9:]/g, "");
        // Seconds must be a valid 00-59 — the regex alone accepts "75" as a
        // syntactically fine two-digit group, but MM:SS with SS >= 60 isn't
        // a real timestamp, just a misread digit. Treated as no read at
        // all (same as not matching the shape), not a value to clamp.
        const mmssRaw = numericOnly.match(/(\d{1,2}):(\d{2})/);
        const mmss = mmssRaw && Number(mmssRaw[2]) <= 59 ? mmssRaw : null;
        const secondsOnly = numericOnly.match(/^(\d{1,3})$/);

        switch (tracker.category) {
          case "kill_banner": {
            const found = OCR_KEYWORDS.find((k) => k.pattern.test(trimmed));
            if (found && (dismissedSuggestionUntilRef.current[found.type] ?? 0) <= Date.now()) {
              // MLBB's own kill banner reads "{player} {MOMENT TEXT}" — the
              // text before the matched keyword is the best guess at a
              // player name; matchPlayerId tolerates OCR noise via its
              // substring fallback, and simply comes back null (still
              // loggable, just unattributed) if nothing resolves.
              const match = trimmed.match(found.pattern);
              const namePart = match ? trimmed.slice(0, match.index).trim() : "";
              const playerId = namePart ? matchPlayerId(namePart) : null;
              const playerName = playerId ? players.find((p) => p.id === playerId)?.ign ?? null : null;
              setSuggestion({ type: found.type, raw: trimmed, playerId, playerName });
            }
            break;
          }
          case "game_timer": {
            const newSeconds = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : null;
            const knownSeconds = lastPersistedSeconds.current ?? game?.current_time_seconds ?? null;
            // Never-decreases — the timer only counts up during live play,
            // so a reading smaller than what's already recorded is always a
            // garbled OCR read, never a real value (a genuine mid-game
            // clock reset isn't a thing MLBB does). A low Tesseract
            // confidence score would make this call even easier, but the
            // guard is unconditional either way — treated exactly like a
            // blank/unreadable tick below, not a rejected-but-otherwise-
            // normal one.
            const isGarbledDecrease = newSeconds != null && knownSeconds != null && newSeconds < knownSeconds;
            if (mmss && !isGarbledDecrease) {
              setMinute(Number(mmss[1]));
              setSecondOfMinute(Number(mmss[2]));
              updateGameClock(Number(mmss[1]), Number(mmss[2]));
              maybeAutoStartGame();
            }
            // No-longer-needed feature (removed per explicit request): this
            // used to infer a "game paused" suggestion after the timer went
            // unreadable for 30+ seconds. Timer just does nothing on a
            // blank/garbled read now — same as every other unreadable
            // tracker — an admin sets Technical Pause manually via the
            // phase stepper instead of being prompted to.
            break;
          }
          case "countdown": {
            if (mmss) updateCountdown(Number(mmss[1]), Number(mmss[2]));
            else if (secondsOnly) updateCountdown(0, Number(secondsOnly[1]));
            break;
          }
          case "team_kills": {
            if (!sideTeamId || !game) break;
            // Digits only — this is the tracker the admin called out as
            // "keep failing," so it gets the strictest cleaning of any
            // category here plus a sanity bound: a raw \d+ match on
            // unfiltered OCR text could latch onto a stray digit from
            // overlay chrome next to the actual kill count, and an absurd
            // read (three-plus digits) is never a real kill count.
            const digitsOnly = trimmed.replace(/[^0-9]/g, "");
            if (!digitsOnly) break;
            const kills = Number(digitsOnly);
            if (!Number.isFinite(kills) || kills < 0 || kills > 300) break;
            const column = sideTeamId === match?.team_a?.id ? "team_a_kills_override" : "team_b_kills_override";
            // Never-decreases — a noisy read lower than what's already
            // recorded is always a misread (kill counts only go up); the
            // manual scoreboard edit is the way to actually correct a
            // wrong count downward.
            const currentKills = column === "team_a_kills_override" ? game.team_a_kills_override : game.team_b_kills_override;
            if (currentKills != null && kills < currentKills) {
              // Almost always a misread (a stray digit from overlay chrome),
              // but flagged rather than silently dropped in case the count
              // genuinely needs a downward correction — same reasoning as
              // every other never-decreases guard here.
              flagReading(tracker.field, {
                label: tracker.label,
                raw: trimmed,
                confidence: data.confidence,
                reason: `Read ${kills}, below the current count of ${currentKills} — never-decreases guard held it back`,
                apply: async () => {
                  await supabase.from("games").update({ [column]: kills }).eq("id", game!.id);
                },
              });
              break;
            }
            await supabase.from("games").update({ [column]: kills }).eq("id", game.id);
            break;
          }
          case "map_setting": {
            if (!game || mapAutoSetForGame.current === game.id) break;
            const found = MAPS.find((m) => trimmed.toLowerCase().includes(m.toLowerCase()));
            if (found) {
              mapAutoSetForGame.current = game.id;
              setGameMap(found);
            }
            break;
          }
          case "objective": {
            if (sideTeamId && objectiveType) {
              await applySingleObjectiveReading(sideTeamId, objectiveType, trimmed, tracker.field, tracker.label, data.confidence);
            }
            break;
          }
          case "objectives_group": {
            if (!sideTeamId || !side) break;
            const counts = parseObjectivesGroupCounts(trimmed);
            // Anything other than exactly 3 clean digit runs isn't a
            // trustworthy split — same treatment as a blank/unreadable
            // tracker everywhere else in this pipeline: skip the tick
            // rather than guess which number is which objective.
            if (counts.length !== 3) break;
            const order = OBJECTIVE_GROUP_ORDER[side];
            for (let i = 0; i < 3; i++) {
              await applySingleObjectiveReading(
                sideTeamId,
                order[i],
                String(counts[i]),
                `${tracker.field}_${order[i]}`,
                `${tracker.label} — ${order[i]}`,
                data.confidence
              );
            }
            break;
          }
          case "net_worth": {
            const gold = parseGoldText(trimmed);
            if (gold == null) break;
            if (side === "left") {
              networthLeft = gold;
              networthLeftField = { field: tracker.field, label: tracker.label, confidence: data.confidence };
            }
            if (side === "right") {
              networthRight = gold;
              networthRightField = { field: tracker.field, label: tracker.label, confidence: data.confidence };
            }
            break;
          }
          case "player_kda": {
            if (!side || !slot) break;
            const playerRow = slotPlayer(side, slot);
            const kda = parseKda(trimmed);
            if (playerRow && kda) {
              const hero = findHeroInText(trimmed);
              kdaParsed.push({
                playerId: playerRow.id,
                heroName: hero?.name ?? null,
                field: tracker.field,
                label: tracker.label,
                raw: trimmed,
                confidence: data.confidence,
                ...kda,
              });
            }
            break;
          }
          case "kda_group": {
            if (!side) break;
            const lines = parseKdaGroupLines(trimmed);
            // Same all-or-nothing logic as objectives_group: fewer than 5
            // clean x/x/x rows means at least one player's row didn't read
            // this tick, and there's no reliable way to tell WHICH slot
            // was the one that failed (a cooldown timer breaking up the
            // block, a row cut off at the edge of the box) — so the whole
            // reading is skipped rather than risk assigning row 3's stats
            // to role slot 4. More than 5 (something outside the 5 rows
            // leaked into the box) is dropped for the same reason.
            if (lines.length !== 5) break;
            for (let i = 0; i < 5; i++) {
              const playerRow = slotPlayer(side, i + 1);
              if (!playerRow) continue;
              kdaParsed.push({
                playerId: playerRow.id,
                // No per-row hero OCR for the combined box — findHeroInText
                // matches against the whole blob, which would misattribute
                // a hero name to every row rather than just the one it
                // actually belongs to. Hero stays whatever it already was;
                // the individual player_kda trackers are the way to get
                // per-tick hero detection if that matters for a broadcast.
                heroName: null,
                field: `${tracker.field}_${i + 1}`,
                label: `${tracker.label} — ${KDA_SLOT_LABELS[i]}`,
                raw: trimmed,
                confidence: data.confidence,
                ...lines[i],
              });
            }
            break;
          }
          case "victory_banner": {
            if (/victory|defeat|win/i.test(trimmed)) {
              const teamId = guessWinnerFromText(trimmed);
              if (teamId) setSuggestedWinner(teamId);
            }
            break;
          }
        }
      } catch (err) {
        console.error(`OCR error (${tracker.field})`, err);
      }
    }

    // Net worth: only worth a snapshot once we actually have both sides.
    // No manual "Snapshot net worth" button anymore — this automatic OCR
    // read (and applyAiDetection's equivalent for the AI-vision path) is
    // the only writer to net_worth_snapshots now.
    if (networthLeft != null && networthRight != null && game && match) {
      const teamAGold = leftTeamId === match.team_a?.id ? networthLeft : networthRight;
      const teamBGold = leftTeamId === match.team_a?.id ? networthRight : networthLeft;
      // Never-decreases, per side independently — net worth only grows
      // during live play, so a reading lower than the last confirmed
      // snapshot is a garbled OCR read, not a real dip. Clamps just the
      // side that misread rather than discarding the whole tick, so a
      // correctly-read side still lands even if the other side glitched.
      const knownAGold = latestNetWorth?.team_a_gold ?? null;
      const knownBGold = latestNetWorth?.team_b_gold ?? null;
      // Net worth "can't be spiked directly, should gradually increase" —
      // on top of the never-decreases clamp above, also cap how far a
      // single 5s tick can raise a side: a genuine burst (a full team wipe
      // plus an objective) plausibly adds a few thousand gold at once, but
      // a jump far beyond that in one tick is far more likely a stray
      // digit inflating the OCR read (e.g. "1.2K" misread as "120K") than
      // real gold. Clamped to the ceiling rather than rejected outright,
      // same "take the plausible part" approach as everywhere else here.
      const MAX_NET_WORTH_GAIN_PER_TICK = 8000;
      const capGain = (known: number | null, read: number) =>
        known != null && read - known > MAX_NET_WORTH_GAIN_PER_TICK ? known + MAX_NET_WORTH_GAIN_PER_TICK : read;
      const safeTeamAGold = capGain(knownAGold, knownAGold != null && teamAGold < knownAGold ? knownAGold : teamAGold);
      const safeTeamBGold = capGain(knownBGold, knownBGold != null && teamBGold < knownBGold ? knownBGold : teamBGold);
      // Whichever side got held back by the never-decreases or spike-cap
      // guard is flagged with the raw (unclamped) reading — a real burst
      // (team wipe + objective) can legitimately exceed the per-tick
      // ceiling, so this is the admin's way to confirm it instead of the
      // guard silently capping it every tick until the game clock catches
      // the gold total up on its own.
      const teamAField = leftTeamId === match.team_a?.id ? networthLeftField : networthRightField;
      const teamBField = leftTeamId === match.team_a?.id ? networthRightField : networthLeftField;
      if (safeTeamAGold !== teamAGold && teamAField) {
        flagReading(teamAField.field, {
          label: teamAField.label,
          raw: String(teamAGold),
          confidence: teamAField.confidence,
          reason: `Read ${teamAGold}, only applied up to ${safeTeamAGold} (never-decreases/spike-cap guard) — confirm to apply the full reading`,
          apply: async () => {
            await supabase.from("net_worth_snapshots").insert({ game_id: game!.id, match_id: matchId, minute_mark: minute, team_a_gold: teamAGold, team_b_gold: safeTeamBGold });
          },
        });
      }
      if (safeTeamBGold !== teamBGold && teamBField) {
        flagReading(teamBField.field, {
          label: teamBField.label,
          raw: String(teamBGold),
          confidence: teamBField.confidence,
          reason: `Read ${teamBGold}, only applied up to ${safeTeamBGold} (never-decreases/spike-cap guard) — confirm to apply the full reading`,
          apply: async () => {
            await supabase.from("net_worth_snapshots").insert({ game_id: game!.id, match_id: matchId, minute_mark: minute, team_a_gold: safeTeamAGold, team_b_gold: teamBGold });
          },
        });
      }
      await supabase.from("net_worth_snapshots").insert({ game_id: game.id, match_id: matchId, minute_mark: minute, team_a_gold: safeTeamAGold, team_b_gold: safeTeamBGold });
    }

    // K/D/A: same auto-upsert precedent already used by the AI-vision path
    // (applyAiDetection) — a misread here just gets corrected by the next
    // tick or a manual edit in Live scoreboard, unlike draft picks (staged,
    // reviewed, pushed explicitly) where a wrong write is a one-time event
    // that's costlier to have gone live. Identity is deterministic now (the
    // tracker's own slot), so there's no more "same player matched on both
    // sides" class of bug to warn about — only a duplicate hero is still
    // worth flagging (a real data problem: two teams can't have picked the
    // same hero).
    if (game) {
      for (const row of kdaParsed) {
        // Never-decreases, per stat independently — kills/deaths/assists
        // only ever go up during a live game, so a noisy read lower than
        // what's already stored for this player is a misread, not a real
        // correction (that's what the manual Live scoreboard edit is for).
        // Clamped per-field rather than rejecting the whole reading, so a
        // correctly-read higher kill count still lands even if deaths or
        // assists misread low on the same tick.
        const existing = stats.find((s) => s.player_id === row.playerId);
        const kills = existing?.kills != null ? Math.max(row.kills, existing.kills) : row.kills;
        const deaths = existing?.deaths != null ? Math.max(row.deaths, existing.deaths) : row.deaths;
        const assists = existing?.assists != null ? Math.max(row.assists, existing.assists) : row.assists;
        // The kda_group combined tracker never reads a hero name per row
        // (see its case above) — row.heroName is always null there. Fall
        // back to whatever's already stored instead of writing null over
        // it, so switching a side to the combined tracker can't wipe hero
        // data that a draft-pick sync or an individual player_kda tracker
        // already set.
        const heroName = row.heroName ?? existing?.hero_name ?? null;
        const heroId = matchHeroId(heroName);
        // A read below what's already stored, on any of the three stats,
        // is held back by the clamp above — flag it instead of silently
        // discarding, in case it's a genuine correction the admin wants
        // to force through rather than a misread.
        if ((existing?.kills != null && row.kills < existing.kills) ||
            (existing?.deaths != null && row.deaths < existing.deaths) ||
            (existing?.assists != null && row.assists < existing.assists)) {
          flagReading(row.field, {
            label: row.label,
            raw: row.raw,
            confidence: row.confidence,
            reason: `Read ${row.kills}/${row.deaths}/${row.assists}, below the stored ${existing?.kills ?? 0}/${existing?.deaths ?? 0}/${existing?.assists ?? 0} — never-decreases guard held it back`,
            apply: async () => {
              await supabase.from("player_stats").upsert(
                { game_id: game.id, match_id: matchId, player_id: row.playerId, hero_name: heroName, hero_id: heroId, kills: row.kills, deaths: row.deaths, assists: row.assists },
                { onConflict: "game_id,player_id" }
              );
            },
          });
        }
        await supabase.from("player_stats").upsert(
          { game_id: game.id, match_id: matchId, player_id: row.playerId, hero_name: heroName, hero_id: heroId, kills, deaths, assists },
          { onConflict: "game_id,player_id" }
        );
      }
    }

    const heroesSeen = kdaParsed.map((r) => r.heroName).filter((h): h is string => Boolean(h));
    const duplicateHero = heroesSeen.find((h, i) => heroesSeen.indexOf(h) !== i);

    // Soft signal only, never blocks a write — team kills and per-player
    // kills are read from entirely separate OCR regions on independent
    // ticks, so some lag between them is normal and a hard reject here
    // would just throw away good data on the slower-updating side. Surfaced
    // the same way the duplicate-hero check already is: a dismissible
    // banner, not a silent drop.
    let kdaMismatch: string | null = null;
    if (game) {
      for (const [label, teamId, opponentTeamId, override] of [
        ["Team A", match?.team_a?.id, match?.team_b?.id, game.team_a_kills_override] as const,
        ["Team B", match?.team_b?.id, match?.team_a?.id, game.team_b_kills_override] as const,
      ]) {
        if (!teamId || override == null) continue;
        const playerKillSum = stats
          .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === teamId)
          .reduce((sum, s) => sum + (s.kills ?? 0), 0);
        if (Math.abs(playerKillSum - override) >= 3) {
          kdaMismatch = `${label}: team kills (${override}) doesn't match the sum of per-player kills (${playerKillSum}) — one of the two OCR reads may be stale or wrong.`;
          break;
        }
        // "Team A kills must equal Team B deaths" (and vice versa) — every
        // kill has exactly one victim, so a team's kill total and the
        // opposing team's total deaths should track each other. Same
        // tolerance/soft-signal-only treatment as the within-team check
        // above, for the same reason: these numbers come from
        // independently-timed OCR reads, so brief lag between them is
        // normal and not worth a hard reject.
        if (opponentTeamId) {
          const opponentDeathSum = stats
            .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === opponentTeamId)
            .reduce((sum, s) => sum + (s.deaths ?? 0), 0);
          if (Math.abs(opponentDeathSum - override) >= 3) {
            kdaMismatch = `${label}: team kills (${override}) doesn't match the opposing team's total deaths (${opponentDeathSum}) — one kill should always mean one death somewhere.`;
            break;
          }
          // "A player's deaths cannot exceed enemy team kills" — every
          // death of an opposing player was caused by one of this team's
          // kills, so no single opposing player's death count can exceed
          // this team's total. Same tolerance/soft-signal treatment as
          // the two checks above.
          const overDyingPlayer = stats
            .filter((s) => players.find((p) => p.id === s.player_id)?.team_id === opponentTeamId)
            .find((s) => (s.deaths ?? 0) > playerKillSum + 2);
          if (overDyingPlayer) {
            const name = players.find((p) => p.id === overDyingPlayer.player_id)?.ign ?? "A player";
            kdaMismatch = `${name}'s deaths (${overDyingPlayer.deaths}) exceed ${label}'s total kills (${playerKillSum}) — a death can't outnumber the enemy's kills, one of the two OCR reads is likely stale or wrong.`;
            break;
          }
        }
      }
    }

    setConsistencyWarning(
      duplicateHero
        ? `"${duplicateHero}" read as picked on two different K/D/A trackers — check hero OCR/roster data.`
        : kdaMismatch
    );

    if (game && kdaParsed.length > 0) loadAll();
  }

  // captureTick/captureFrameAndAnalyze are plain functions recreated on
  // every render, closing over that render's state — regions, match, game,
  // players, heroes, stagedDraftActions, all of it. A bare
  // setInterval(captureTick, 5000) locks in whatever those values were AT
  // THE MOMENT "Start capture" was clicked and never sees anything
  // calibrated or changed afterward (a region drawn mid-session, a phase
  // transition to Game ongoing, a roster edit) for the rest of that
  // capture session — this is the real reason OCR looked completely dead
  // once the match moved past whatever phase was active when capture
  // started, not an OCR-accuracy problem but a stale-closure one (the
  // classic setInterval-in-React pitfall). Routing the interval through a
  // ref that's refreshed to the latest closure every render fixes it
  // without needing to tear down and recreate the interval on every state
  // change.
  const captureTickRef = useRef(captureTick);
  const captureFrameAndAnalyzeRef = useRef(captureFrameAndAnalyze);
  useEffect(() => {
    captureTickRef.current = captureTick;
    captureFrameAndAnalyzeRef.current = captureFrameAndAnalyze;
  });

  async function startCapture() {
    try {
      // No preferCurrentTab, and this never opens/focuses any window on the
      // admin's behalf — auto-opening a tab just got in the way (a
      // redundant tab nobody asked for, and re-focusing it on a later
      // "Start capture" click could yank focus away from whatever
      // fullscreen window the admin had actually set up themselves). The
      // admin opens and fullscreens their own stream source however they
      // like — this only asks the browser for something to capture;
      // nothing here ever touches that window once picked, and no
      // admin-side action (a confirm() dialog, a button click, navigating
      // this page) can disrupt a separate window's fullscreen state —
      // that's an OS/browser-level property of the *other* window, this
      // page has no handle to it at all.
      //
      // displaySurface: "window" (not "browser") restricts the picker to
      // whole application windows rather than browser tabs specifically —
      // this is the one that actually survives Alt+Tab. A captured
      // *window* keeps delivering frames as long as it exists and isn't
      // minimized, regardless of whether it's focused or occluded by
      // something else on screen (that's what OS-level window capture is
      // for). A captured *tab* only reliably keeps updating while it's
      // the frontmost tab of a visible window — switch away and several
      // browsers throttle or freeze its rendering, which is exactly the
      // "capture stalls on Alt+Tab" symptom this fixes. "window" also
      // still rules out capturing the whole desktop (which would drag in
      // the OS taskbar, notifications, or other apps).
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "window" },
      });
      streamRef.current = stream;
      captureStartedAtRef.current = Date.now();
      // previewRef.current is null here — the <video> only exists in the
      // DOM once captureActive is true, and this runs before that state
      // update is committed. Attaching srcObject was silently a no-op the
      // whole time (video always mounted with nothing attached, hence
      // permanently black regardless of what was shared). The actual
      // attach now happens in the effect below, which fires after React
      // has mounted the element.
      setCaptureActive(true);
      if (captureMode === "ai") {
        // 60s cadence, not 5s like the manual OCR loop. Confirmed against
        // two real 429s in production that downscaling the frame only
        // trims request size modestly (~6045 -> ~5045 tokens) — this vision
        // model evidently normalizes images to something close to a fixed
        // internal size, so it doesn't scale down much further with input
        // resolution. Against an 8000 tokens-per-minute free-tier budget,
        // a ~5000-token request only has room for one per rolling minute;
        // anything faster was guaranteed to fail on most ticks.
        intervalRef.current = setInterval(() => captureFrameAndAnalyzeRef.current(), 60000);
      } else {
        workerRef.current = await createWorker("eng");
        intervalRef.current = setInterval(() => captureTickRef.current(), 5000);
      }
    } catch (err) {
      console.error("Could not start screen share for local capture", err);
    }
  }

  function stopCapture() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    workerRef.current?.terminate();
    captureStartedAtRef.current = null;
    setCaptureActive(false);
    setSuggestion(null);
    setAiDetection(null);
    setAiStatus(null);
  }

  // Runs after captureActive flips true and React has actually mounted the
  // <video> element — this is what attaches the shared stream, not
  // startCapture() itself (see the comment there).
  useEffect(() => {
    if (!captureActive || !streamRef.current || !previewRef.current) return;
    const video = previewRef.current;
    video.srcObject = streamRef.current;
    video.play().catch((err) => console.error("Preview play() failed", err));

    if (captureMode !== "ai") return;
    // setInterval (in startCapture) never fires its callback immediately —
    // only after the first full 60s pacing window — so without this, the
    // console sits on "Waiting for first frame..." for a full minute after
    // every "Start capture" click, which reads as hung rather than paced.
    // The 60s budget only needs to apply *between* calls, so fire one as
    // soon as the video actually has a frame ready instead.
    const fireFirstFrame = () => captureFrameAndAnalyze();
    if (video.readyState >= 1) fireFirstFrame(); // HAVE_METADATA already reached
    else video.addEventListener("loadedmetadata", fireFirstFrame, { once: true });
    return () => video.removeEventListener("loadedmetadata", fireFirstFrame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureActive]);

  useEffect(() => {
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A closed tab, refresh, or typed-in URL while capture is running tears
  // down the screen-share stream and the OCR interval with no way back —
  // the admin has to re-share the screen and, worse, re-calibrate nothing
  // since regions persist, but loses whatever the running session's local
  // state (staged draft actions, in-flight readings) hadn't been saved
  // yet. Browsers only allow a generic native confirmation here (custom
  // text in the dialog was removed from all major browsers years ago for
  // abuse-prevention reasons), but that's still real friction against an
  // accidental close mid-broadcast.
  useEffect(() => {
    if (!captureActive) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [captureActive]);

  useEffect(() => {
    if (!match || !DRAFT_PHASES.includes(match.state)) setDraftSim(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.state]);

  function clientToPct(clientX: number, clientY: number, rect: DOMRect) {
    return {
      x: Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100)),
    };
  }

  // Starts a drag: drawing a brand-new box (no draftBox yet), moving the
  // whole box, or resizing from one corner. e.stopPropagation() keeps a
  // handle's own mousedown from also bubbling to the container's
  // "start a fresh draw" handler. `target` picks which state the drag
  // writes into — defaults to the existing pick-tracker-then-draw flow
  // (draftBox); the slide-anywhere draw-then-pick flow passes "pendingBox"
  // instead, since that box exists before any tracker is chosen.
  function startBoxDrag(mode: DragMode, e: React.MouseEvent, target: "draftBox" | "pendingBox" = "draftBox") {
    if (target === "draftBox" && !calibratingField) return;
    e.stopPropagation();
    const container = e.currentTarget.closest("[data-crop-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    cropRectRef.current = rect;
    dragMode.current = mode;
    dragTarget.current = target;
    dragStartPct.current = clientToPct(e.clientX, e.clientY, rect);
    dragStartBox.current = target === "pendingBox" ? pendingBox : draftBox;
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const mode = dragMode.current;
      const rect = cropRectRef.current;
      const start = dragStartPct.current;
      if (!mode || !rect || !start) return;
      const pt = clientToPct(e.clientX, e.clientY, rect);
      const setBox = dragTarget.current === "pendingBox" ? setPendingBox : setDraftBox;

      if (mode === "draw") {
        setBox({
          xPct: Math.min(start.x, pt.x),
          yPct: Math.min(start.y, pt.y),
          wPct: Math.abs(pt.x - start.x),
          hPct: Math.abs(pt.y - start.y),
        });
        return;
      }
      const startBox = dragStartBox.current;
      if (!startBox) return;
      if (mode === "move") {
        const dx = pt.x - start.x;
        const dy = pt.y - start.y;
        setBox({
          ...startBox,
          xPct: Math.min(100 - startBox.wPct, Math.max(0, startBox.xPct + dx)),
          yPct: Math.min(100 - startBox.hPct, Math.max(0, startBox.yPct + dy)),
        });
        return;
      }
      // Corner handles — each recomputed from the box-at-drag-start plus
      // the opposite (anchor) edge, not incremental deltas, so a fast or
      // jittery drag can't accumulate drift.
      const right = startBox.xPct + startBox.wPct;
      const bottom = startBox.yPct + startBox.hPct;
      let { xPct, yPct, wPct, hPct } = startBox;
      const MIN = 1.5; // pct — a region under ~1.5% of the preview isn't usable for OCR anyway
      if (mode.includes("w")) {
        xPct = Math.min(pt.x, right - MIN);
        wPct = right - xPct;
      }
      if (mode.includes("e")) {
        wPct = Math.max(MIN, pt.x - startBox.xPct);
      }
      if (mode.includes("n")) {
        yPct = Math.min(pt.y, bottom - MIN);
        hPct = bottom - yPct;
      }
      if (mode.includes("s")) {
        hPct = Math.max(MIN, pt.y - startBox.yPct);
      }
      setBox({ xPct, yPct, wPct, hPct });
    }
    function onUp() {
      dragMode.current = null;
      dragStartPct.current = null;
      dragStartBox.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function lockDraftBox() {
    if (!calibratingField || !draftBox) return;
    if (draftBox.wPct < 1 || draftBox.hPct < 1) return; // too small to be a real region — ignore
    saveRegion(calibratingField, draftBox);
    setDraftBox(null);
    setCalibratingField(null);
  }
  function cancelDraftBox() {
    setDraftBox(null);
    setCalibratingField(null);
  }
  function startCalibrating(field: string) {
    setCalibratingField(field);
    setDraftBox(regions[field] ?? null);
    // Clicking "Calibrate"/"Resize" in the tracker table is an explicit
    // request to edit — turn edit mode on so the canvas actually responds
    // to the drag that's about to happen, rather than requiring a second
    // manual toggle click right after.
    setTrackerEditMode(true);
  }

  // ── Captured area drag ───────────────────────────────────────────────
  // Deliberately its own small drag implementation (mirroring
  // startBoxDrag/onMove above) rather than a third dragTarget on that
  // shared one — this box has no "which tracker" step, no corner-handle
  // MIN-size floor tied to OCR usability, and only ever exists one at a
  // time, so keeping it separate means calibrating a tracker can never
  // accidentally drag the area (or vice versa) through shared drag state.
  function startCaptureAreaDrag(mode: DragMode, e: React.MouseEvent) {
    e.stopPropagation();
    const container = e.currentTarget.closest("[data-crop-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    captureAreaCropRectRef.current = rect;
    captureAreaDragMode.current = mode;
    captureAreaDragStartPct.current = clientToPct(e.clientX, e.clientY, rect);
    captureAreaDragStartBox.current = captureAreaDraft;
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const mode = captureAreaDragMode.current;
      const rect = captureAreaCropRectRef.current;
      const start = captureAreaDragStartPct.current;
      if (!mode || !rect || !start) return;
      const pt = clientToPct(e.clientX, e.clientY, rect);
      if (mode === "draw") {
        setCaptureAreaDraft({
          xPct: Math.min(start.x, pt.x),
          yPct: Math.min(start.y, pt.y),
          wPct: Math.abs(pt.x - start.x),
          hPct: Math.abs(pt.y - start.y),
        });
        return;
      }
      const startBox = captureAreaDragStartBox.current;
      if (!startBox) return;
      if (mode === "move") {
        const dx = pt.x - start.x;
        const dy = pt.y - start.y;
        setCaptureAreaDraft({
          ...startBox,
          xPct: Math.min(100 - startBox.wPct, Math.max(0, startBox.xPct + dx)),
          yPct: Math.min(100 - startBox.hPct, Math.max(0, startBox.yPct + dy)),
        });
        return;
      }
      const right = startBox.xPct + startBox.wPct;
      const bottom = startBox.yPct + startBox.hPct;
      let { xPct, yPct, wPct, hPct } = startBox;
      const MIN = 3; // pct — the captured area is a coarse boundary box, not a fine OCR crop
      if (mode.includes("w")) {
        xPct = Math.min(pt.x, right - MIN);
        wPct = right - xPct;
      }
      if (mode.includes("e")) {
        wPct = Math.max(MIN, pt.x - startBox.xPct);
      }
      if (mode.includes("n")) {
        yPct = Math.min(pt.y, bottom - MIN);
        hPct = bottom - yPct;
      }
      if (mode.includes("s")) {
        hPct = Math.max(MIN, pt.y - startBox.yPct);
      }
      setCaptureAreaDraft({ xPct, yPct, wPct, hPct });
    }
    function onUp() {
      captureAreaDragMode.current = null;
      captureAreaDragStartPct.current = null;
      captureAreaDragStartBox.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);
  function startEditingCaptureArea() {
    setCaptureAreaDraft(captureArea);
    setCaptureAreaEditMode(true);
  }
  function lockCaptureArea() {
    if (!captureAreaDraft) return;
    if (captureAreaDraft.wPct < 3 || captureAreaDraft.hPct < 3) return; // too small to be a real boundary — ignore
    saveCaptureArea(captureAreaDraft);
    setCaptureAreaEditMode(false);
  }
  function cancelCaptureAreaEdit() {
    setCaptureAreaDraft(captureArea);
    setCaptureAreaEditMode(false);
  }
  function clearCaptureArea() {
    setCaptureAreaDraft(null);
    saveCaptureArea(null);
    setCaptureAreaEditMode(false);
  }

  async function confirmSuggestion() {
    if (!suggestion || !game) return;
    const tpl = momentTemplates.find((t) => t.type === suggestion.type && (!t.phase || t.phase === match?.state));
    const playerName = suggestion.playerName ?? "";
    const description = tpl
      ? fillTelegramTemplate(tpl.label_template, { player: playerName })
      : fillTelegramTemplate(DEFAULT_MOMENT_LABELS[suggestion.type] ?? suggestion.type, { player: playerName });
    const { error } = await supabase.from("key_moments").insert({
      game_id: game.id,
      match_id: matchId,
      type: suggestion.type,
      description,
      player_id: suggestion.playerId ?? null,
      minute_mark: minute,
      second_mark: secondOfMinute,
      source: "manual",
      is_key_moment: KEY_MOMENT_TYPES.includes(suggestion.type),
    });
    if (error) {
      setError(error.message);
      return;
    }
    if (tpl?.telegram_enabled) {
      const message = tpl.telegram_message_template
        ? fillTelegramTemplate(tpl.telegram_message_template, { player: playerName, team: "", hero: "", timestamp: mmssTimestamp() })
        : `🔥 <b>${description}</b>\n${match?.team_a?.name} vs ${match?.team_b?.name}\n${match?.tournament?.name}`;
      postToTelegram(message, { entityType: "key_moment", entityId: game.id, notificationType: "key_moment_auto" });
    }
    setSuggestion(null);
    loadAll();
  }

  async function setGameMap(map: string) {
    if (!game) return;
    const { error } = await supabase.from("games").update({ map }).eq("id", game.id);
    if (error) setError(error.message);
    else loadAll();
  }

  // Finishes the current game with a winner, then either closes out the
  // series (once a team hits the format's required win count) or advances
  // current_game_number so the next loadAll() auto-creates the next game —
  // this is what was missing for "per game result" to show anywhere.
  const SERIES_WINS_REQUIRED: Record<string, number> = { BO1: 1, BO2: 2, BO3: 2, BO5: 3, BO7: 4 };
  async function declareGameWinner(teamId: string) {
    if (!game || !match) return;
    if (!confirm("Finish this game with this team as the winner?")) return;

    const { error: gameErr } = await supabase
      .from("games")
      .update({ status: "finished", state: "GAME_FINISHED", winner_team_id: teamId, finished_at: new Date().toISOString() })
      .eq("id", game.id);
    if (gameErr) {
      setError(gameErr.message);
      return;
    }

    const allGames = [...pastGames, { ...game, winner_team_id: teamId }];
    const winsFor = (id: string) => allGames.filter((g) => g.winner_team_id === id).length;
    const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
    const seriesWinner = aWins >= required ? match.team_a?.id : bWins >= required ? match.team_b?.id : null;

    const { error } = seriesWinner
      ? await supabase
          .from("matches")
          .update({ status: "finished", state: "SERIES_FINISHED", series_winner_team_id: seriesWinner })
          .eq("id", match.id)
      : await supabase
          .from("matches")
          .update({ current_game_number: match.current_game_number + 1, state: "GAME_FINISHED" })
          .eq("id", match.id);
    if (error) setError(error.message);

    // Every game (and series) result gets its own moment-list entry, not
    // just a Telegram post — the public Moment list is otherwise silent on
    // exactly the two moments viewers care about most.
    if (match.update_source === "local_ocr") {
      const winnerName = teamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "game_finish",
        description: `${winnerName} wins Game ${game.game_number}`,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
        is_key_moment: true,
      });
      if (seriesWinner) {
        const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
        await supabase.from("key_moments").insert({
          game_id: game.id,
          match_id: matchId,
          type: "match_finish",
          description: `${seriesWinnerName} wins the series ${Math.max(aWins, bWins)}–${Math.min(aWins, bWins)}`,
          minute_mark: minute,
          second_mark: secondOfMinute,
          source: "manual",
          is_key_moment: true,
        });
      }
    }

    // The worker posts these automatically for Liquipedia-sourced matches,
    // but never sees local_ocr matches at all — post from here instead so
    // those results still reach Telegram. notification_tier gates which of
    // the two actually go out: per-game "result" posts are Hot-only (the
    // spec calls this out as "no per-game update spam" for Priority);
    // match-finished (with the hero-picks recap below) goes to both
    // Priority and Hot. Normal tier gets neither, same as everywhere else.
    if (match.update_source === "local_ocr") {
      const tier = match.notification_tier ?? "normal";
      const winnerName = teamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      const vars = {
        team_a: match.team_a?.name ?? "",
        team_b: match.team_b?.name ?? "",
        tournament: match.tournament?.name ?? "",
        winner: winnerName ?? "",
        timestamp: mmssTimestamp(),
      };
      if (tier === "hot") {
        const gameMsg = telegramMessageFor(
          "game_finish",
          `🎮 <b>Game ${game.game_number} result</b>\nWinner: <b>${winnerName}</b>\n<b>${match.team_a?.name} ${aWins} - ${bWins} ${match.team_b?.name}</b>\n${match.tournament?.name}`,
          vars
        );
        if (gameMsg) await postToTelegram(gameMsg, { entityType: "game", entityId: game.id, notificationType: "game_result" });
      }
      if (seriesWinner && (tier === "hot" || tier === "priority")) {
        const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
        const recap = await buildSeriesHeroRecap();
        const matchMsg = telegramMessageFor(
          "match_finish",
          `🏆 <b>Match finished</b>\nWinner: <b>${seriesWinnerName}</b>\nFinal score: <b>${match.team_a?.name} ${aWins} - ${bWins} ${match.team_b?.name}</b>\n${match.tournament?.name}${recap ? `\n\n${recap}` : ""}`,
          { ...vars, winner: seriesWinnerName ?? "" }
        );
        if (matchMsg) await postToTelegram(matchMsg, { entityType: "match", entityId: match.id, notificationType: "match_finished" });
      }
    }

    loadAll();
  }

  // Closes out the series from already-clinched game results (the phase
  // dropdown's "Series finished" option), as opposed to declareGameWinner
  // which closes out the CURRENT game and only promotes to series-finished
  // as a side effect of that. Shares the same finalize/notify shape so a
  // manual dropdown selection ends up in the same state as the button-
  // driven path — final score set, Telegram sent, status set to finished.
  async function finalizeSeriesFinished(seriesWinner: string, aWins: number, bWins: number) {
    if (!match || !game) return;
    const { error } = await supabase
      .from("matches")
      .update({ status: "finished", state: "SERIES_FINISHED", series_winner_team_id: seriesWinner })
      .eq("id", match.id);
    if (error) {
      setError(error.message);
      return;
    }
    if (match.update_source === "local_ocr") {
      const tier = match.notification_tier ?? "normal";
      const seriesWinnerName = seriesWinner === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "match_finish",
        description: `${seriesWinnerName} wins the series ${Math.max(aWins, bWins)}–${Math.min(aWins, bWins)}`,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
        is_key_moment: true,
      });
      if (tier === "hot" || tier === "priority") {
        const recap = await buildSeriesHeroRecap();
        const matchMsg = telegramMessageFor(
          "match_finish",
          `🏆 <b>Match finished</b>\nWinner: <b>${seriesWinnerName}</b>\nFinal score: <b>${match.team_a?.name} ${aWins} - ${bWins} ${match.team_b?.name}</b>\n${match.tournament?.name}${recap ? `\n\n${recap}` : ""}`,
          {
            team_a: match.team_a?.name ?? "",
            team_b: match.team_b?.name ?? "",
            tournament: match.tournament?.name ?? "",
            winner: seriesWinnerName ?? "",
            timestamp: mmssTimestamp(),
          }
        );
        if (matchMsg) await postToTelegram(matchMsg, { entityType: "match", entityId: match.id, notificationType: "match_finished" });
      }
    }
    loadAll();
  }

  const [forceWinnerPrompt, setForceWinnerPrompt] = useState(false);

  // Everything lib/matchPhase's getLegalTransitions needs to evaluate every
  // phase move at once — computed here (not scattered checks) so the phase
  // stepper UI and handlePhaseChange's guard below are always answering
  // from the exact same rules, never out of sync with each other.
  const phaseSignals: PhaseSignals | null =
    match && game
      ? {
          currentPhase: match.state as MatchPhase,
          matchIsLive: match.status === "live",
          hasBothTeams: Boolean(match.team_a && match.team_b),
          rosterReady:
            Boolean(match.team_a) && Boolean(match.team_b)
              ? players.filter((p) => p.team_id === match.team_a!.id && p.is_active_roster).length === 5 &&
                players.filter((p) => p.team_id === match.team_b!.id && p.is_active_roster).length === 5
              : false,
          draftFullyResolved: draftFullyResolved(),
          hasStreamUrl: Boolean(match.youtube_url),
          currentGameHasWinner: Boolean(game.winner_team_id),
          seriesWinsRequired: SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2,
          teamAGameWins: match.team_a
            ? pastGames.filter((g) => g.winner_team_id === match.team_a!.id).length + (game.winner_team_id === match.team_a.id ? 1 : 0)
            : 0,
          teamBGameWins: match.team_b
            ? pastGames.filter((g) => g.winner_team_id === match.team_b!.id).length + (game.winner_team_id === match.team_b.id ? 1 : 0)
            : 0,
          isLastGameOfSeries: false,
        }
      : null;
  if (phaseSignals) {
    const required = phaseSignals.seriesWinsRequired;
    phaseSignals.isLastGameOfSeries = phaseSignals.teamAGameWins >= required || phaseSignals.teamBGameWins >= required;
  }
  const phaseTransitions = phaseSignals ? getLegalTransitions(phaseSignals) : [];

  // Single gatekeeper for every phase-stepper click — routes Game/Series
  // finished through the same winner-declaration logic the dedicated
  // buttons already use instead of setting those states directly with no
  // winner attached, and defers everything else (is this move even legal
  // right now) to lib/matchPhase so the rule lives in exactly one place.
  async function handlePhaseChange(newState: string) {
    if (!match || !game || !phaseSignals) return;
    const currentState = match.state;
    if (currentState === newState) return;

    if (newState === "GAME_FINISHED") {
      if (!phaseSignals.currentGameHasWinner) {
        setForceWinnerPrompt(true);
        return;
      }
      // A winner's already on the row (e.g. re-confirming after a manual
      // edit) — nothing left to prompt for, just move the phase forward.
    } else if (newState === "SERIES_FINISHED") {
      const required = phaseSignals.seriesWinsRequired;
      const seriesWinner =
        phaseSignals.teamAGameWins >= required ? match.team_a?.id : phaseSignals.teamBGameWins >= required ? match.team_b?.id : null;
      if (!seriesWinner) {
        setError(`Series finished can't be set yet — no team has reached ${required} game win(s) for ${match.format ?? "BO3"}.`);
        return;
      }
      await finalizeSeriesFinished(seriesWinner, phaseSignals.teamAGameWins, phaseSignals.teamBGameWins);
      return;
    } else {
      const transition = getLegalTransitions({ ...phaseSignals, currentPhase: currentState as MatchPhase }).find((t) => t.phase === newState);
      if (transition && !transition.legal) {
        setError(transition.blockedReason ?? `Can't move to ${newState.replace(/_/g, " ")} right now.`);
        return;
      }
    }

    // Pause/resume the manual stopwatch across a technical pause — the OCR
    // clock needs no equivalent handling, since a genuinely paused game's
    // on-screen timer just stops changing, which OCR reads as-is.
    if (newState === "TECHNICAL_PAUSE" && game.clock_source === "manual" && game.manual_time_running) {
      await pauseManualClock();
    }
    if (currentState === "TECHNICAL_PAUSE" && newState === "GAME_STARTED" && game.clock_source === "manual" && !game.manual_time_running) {
      await startManualClock();
    }

    await setMatchPhase(newState);
  }

  // Direct correction for a game's winner (current or a past one), for
  // fixing a wrong call after the fact — distinct from declareGameWinner,
  // which is for FIRST closing out a game and advances current_game_number/
  // posts Telegram as a new event. This only touches the one games row and
  // silently recomputes the series winner from the corrected results,
  // without re-sending any notifications for what is a correction, not a
  // new result.
  async function correctGameWinner(gameId: string, teamId: string) {
    if (!match) return;
    const { error } = await supabase
      .from("games")
      .update({ winner_team_id: teamId, status: "finished", state: "GAME_FINISHED" })
      .eq("id", gameId);
    if (error) {
      setError(error.message);
      return;
    }
    const allWinners: (string | null)[] = pastGames.map((g) => (g.id === gameId ? teamId : g.winner_team_id));
    if (game) allWinners.push(game.id === gameId ? teamId : game.winner_team_id);
    const winsFor = (id: string) => allWinners.filter((w) => w === id).length;
    const required = SERIES_WINS_REQUIRED[match.format ?? "BO3"] ?? 2;
    const aWins = match.team_a ? winsFor(match.team_a.id) : 0;
    const bWins = match.team_b ? winsFor(match.team_b.id) : 0;
    const seriesWinner = aWins >= required ? match.team_a?.id : bWins >= required ? match.team_b?.id : null;
    await supabase
      .from("matches")
      .update({ series_winner_team_id: seriesWinner, state: seriesWinner ? "SERIES_FINISHED" : match.state, status: seriesWinner ? "finished" : match.status })
      .eq("id", match.id);
    loadAll();
  }

  // Unified Normal/Priority/Hot dropdown — sets update_source and
  // notification_tier together, see lib/matchTier.ts for the exact mapping.
  async function setMatchTier(tier: MatchTier) {
    if (!match || isContributor) return;
    await supabase.from("matches").update(matchTierFields(tier)).eq("id", match.id);
    loadAll();
  }

  const [statusSaving, setStatusSaving] = useState(false);
  async function updateMatchStatus(status: "scheduled" | "live" | "finished") {
    if (!match || status === match.status || isContributor) return;
    if (status === "live" && !match.youtube_url) return;
    setStatusSaving(true);
    const { error } = await supabase.from("matches").update({ status }).eq("id", match.id);
    setStatusSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    loadAll();
  }

  // Full reset for a Normal match gone wrong (bad sync, wrong teams matched,
  // etc.) — every child table keyed by match_id, then the games themselves,
  // then the match row back to its pre-anything state so the next sync (or
  // manual entry) starts clean instead of layering on top of stale rows.
  async function resetMatch() {
    if (!match || isContributor) return;
    if (
      !confirm(
        "Reset this entire match? This deletes all games, picks/bans, stats, objectives, and moments for it, and reverts it to Match not started. This can't be undone."
      )
    )
      return;
    await Promise.all([
      supabase.from("hero_picks_bans").delete().eq("match_id", match.id),
      supabase.from("player_stats").delete().eq("match_id", match.id),
      supabase.from("objectives").delete().eq("match_id", match.id),
      supabase.from("net_worth_snapshots").delete().eq("match_id", match.id),
      supabase.from("game_screenshots").delete().eq("match_id", match.id),
      supabase.from("key_moments").delete().eq("match_id", match.id),
    ]);
    await supabase.from("games").delete().eq("match_id", match.id);
    const { error } = await supabase
      .from("matches")
      .update({ state: "MATCH_NOT_STARTED", status: "scheduled", current_game_number: 1, series_winner_team_id: null })
      .eq("id", match.id);
    if (error) setError(error.message);
    // Every games row for this match was just deleted and current_game_number
    // reset to 1 — but selectedGameNumber is local state Reset match never
    // touched. Left stale (e.g. 3, if the admin was mid-series when they
    // reset), the next loadAll() would target game_number 3 against a
    // match whose current_game_number is now 1, find no row (everything
    // was just deleted), and silently upsert a *new* "draft" Game 3 row
    // instead of following the fresh Game 1 — the same class of bug as the
    // declareGameWinner staleness fix above, just via a different trigger.
    setSelectedGameNumber(null);
    loadAll();
  }

  // What this phase's tracker area actually does — only GAME_STARTED and
  // TECHNICAL_PAUSE have a real OCR tracker at all now (see TRACKER_PHASES
  // above); every other match phase is driven by the admin's own manual
  // controls, so the hint just says so via NO_TRACKER_PHASE_HINT below
  // instead of describing a tracker that no longer exists for that phase.
  const PHASE_TRACKER_HINTS: Record<string, string> = {
    GAME_STARTED: "Game ongoing — the main event: game timer, objectives, kills, net worth, and per-player K/D/A all track here (one region per side), applying automatically each tick. Set which side is \"left\" below.",
    TECHNICAL_PAUSE: "Technical pause — tracker just looks for the word \"pause\" to confirm what you already flagged manually.",
  };
  const NO_TRACKER_PHASE_HINT = "No tracker for this phase — OCR capture only runs during Game ongoing or Technical pause. Everything else here is driven by the manual controls above.";
  async function setMatchPhase(newState: string) {
    if (!match) return;
    const previousState = match.state;
    const { error } = await supabase.from("matches").update({ state: newState }).eq("id", match.id);
    if (error) {
      setError(error.message);
      return;
    }
    // "Match started" — the Priority-tier baseline notification (Hot gets
    // it too, alongside its own extra triggers below). The worker owns this
    // for Liquipedia-sourced matches (scheduleSync.mjs's match_live, fired
    // on the scheduled->live transition); it never sees local_ocr matches,
    // so this is the equivalent moment for those — the first time the
    // phase actually moves off MATCH_NOT_STARTED. Fires once, independent
    // of the Hot-only granular triggers further down, and independent of
    // whether this match even has a moment log (that's update_source-gated
    // below, not tier-gated).
    if (
      match.update_source === "local_ocr" &&
      previousState === "MATCH_NOT_STARTED" &&
      newState !== "MATCH_NOT_STARTED" &&
      (match.notification_tier === "priority" || match.notification_tier === "hot")
    ) {
      const startMsg =
        `🟢 <b>Match started</b>\n${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}` +
        (match.youtube_url ? `\n${match.youtube_url}` : "");
      await postToTelegram(startMsg, { entityType: "match", entityId: match.id, notificationType: "match_started" });
    }

    // Only Hot matches get a moment log at all (Normal/Priority matches
    // hide that section entirely — see the update_source check further
    // down), so only they get phase transitions recorded into it.
    if (game && match.update_source === "local_ocr" && newState !== previousState) {
      await supabase.from("key_moments").insert({
        game_id: game.id,
        match_id: matchId,
        type: "phase_change",
        description: `Phase changed to ${newState.replace(/_/g, " ")}`,
        minute_mark: minute,
        second_mark: secondOfMinute,
        source: "manual",
      });

      // Hot-TIER matches (not just Hot/local_ocr data-source ones — see the
      // notification_tier check below) get a handful of phase transitions
      // auto-shared to Telegram — the worker never sees local_ocr matches
      // at all (see the postToTelegram comment above), so nothing else
      // announces these. A local_ocr match downgraded to Priority/Normal
      // tier still gets the moment-log entry just above, just not this
      // Telegram spam — Priority's whole point is exactly two automatic
      // posts (match-started, match-finished), not per-phase updates.
      // Which transitions actually post, and with what message, is
      // config-driven via the "phase_notice" rows on /admin/moment-templates
      // instead of hardcoded here — falls back to a sensible default message
      // per phase if a row exists but has no custom template text.
      if (newState !== previousState && game && match.notification_tier === "hot") {
        const noticeTemplate = momentTemplates.find((t) => t.type === "phase_notice" && t.phase === newState);
        const header = `${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`;
        const DEFAULT_PHASE_MESSAGES: Record<string, string> = {
          DRAFT_STARTED: `✏️ <b>Draft started — Game ${game.game_number}</b>\n${header}`,
          DRAFT_COMPLETE: `📋 <b>Draft complete — Game ${game.game_number}</b>\n<b>${seriesScoreLine()}</b>\n${match.tournament?.name}\n\n${buildDraftRecap()}`,
          GAME_STARTED: `🎮 <b>Game ${game.game_number} ongoing</b>\n${header}`,
          TECHNICAL_PAUSE: `⏸️ <b>Technical pause</b>\n${header}`,
          STREAM_ENDED: `📴 <b>Stream ended</b>\n${header}`,
        };
        // Draft-complete specifically must not announce a recap that's
        // still missing picks — a phase transition can happen (manually,
        // or once OCR/AI infers it) before all 10 players actually have a
        // hero resolved, whether that resolution came from OCR auto-detect
        // or a manual edit. The "📢 Announce draft" button stays a manual
        // override with no such gate — clicking it IS the "or manually"
        // case this is meant to allow.
        const blockedByIncompleteDraft = newState === "DRAFT_COMPLETE" && !draftFullyResolved();
        if (noticeTemplate?.telegram_enabled && !blockedByIncompleteDraft) {
          const message = noticeTemplate.telegram_message_template
            ? fillTelegramTemplate(noticeTemplate.telegram_message_template, {
                team_a: match.team_a?.name ?? "",
                team_b: match.team_b?.name ?? "",
                tournament: match.tournament?.name ?? "",
                game: String(game.game_number),
                timestamp: mmssTimestamp(),
              })
            : DEFAULT_PHASE_MESSAGES[newState];
          if (message) {
            await postToTelegram(message, {
              entityType: newState === "DRAFT_COMPLETE" || newState === "GAME_STARTED" ? "game" : "match",
              entityId: newState === "DRAFT_STARTED" ? match.id : game.id,
              notificationType:
                newState === "DRAFT_STARTED" ? "draft_started"
                : newState === "DRAFT_COMPLETE" ? "draft_result"
                : newState === "GAME_STARTED" ? "game_started"
                : newState === "TECHNICAL_PAUSE" ? "technical_pause"
                : "stream_ended",
            });
          }
        }
      }
    }
    loadAll();
  }
  // Only a genuine load failure (the match/game never came back at all)
  // is worth a full-page message — every other setError() call happens
  // once the console is already up and running (a rejected phase change,
  // a blocked delete, etc.), and previously replaced this entire live
  // page with a bare line of red text, which during an actual broadcast
  // read as "the page just disappeared." Those now show as a dismissible
  // toast instead (rendered near the bottom of this component) without
  // tearing down the console underneath.
  // Hooks below are declared here, immediately above the loading guard,
  // specifically because they must NOT come after it — an early return
  // can't skip a hook call between one render (match/game still null) and
  // the next (match/game loaded) without violating the Rules of Hooks,
  // which throws "Rendered more hooks than during the previous render"
  // and takes down the whole page with the generic client-side-exception
  // screen. These used to live further down, next to the roster-edit UI
  // and OCR panel they belong to logically, but that's exactly what broke.
  const [editingRosterPlayerId, setEditingRosterPlayerId] = useState<string | null>(null);
  const [editingRosterIgn, setEditingRosterIgn] = useState("");
  const [editingRosterRole, setEditingRosterRole] = useState("");
  const [newRosterName, setNewRosterName] = useState<Record<string, string>>({});
  const preGuardActiveTrackers = trackers.filter((t) => t.phase === match?.state);
  const preGuardAllTrackersCalibrated = preGuardActiveTrackers.length > 0 && preGuardActiveTrackers.every((t) => regions[t.field]);
  useEffect(() => {
    if (ocrAutoCollapsedRef.current || !preGuardAllTrackersCalibrated) return;
    setOcrDetailsOpen(false);
    ocrAutoCollapsedRef.current = true;
  }, [preGuardAllTrackersCalibrated]);

  if (!match || !game) return <p className="text-red-400 text-sm">{error ?? "Loading match..."}</p>;

  // A contributor only ever reaches this page for a finished match — the
  // request/approval workflow (buffered pendingMatchEdits, submitted as
  // one edit_requests row) only makes sense for a match that's done, not
  // one still being actively tracked. Blocked here rather than in a
  // separate route because this IS the admin route — a contributor's
  // /contributor layout wraps them into this same page component, not a
  // parallel one, so the guard has to live where both actors land.
  if (isContributor && match.status !== "finished") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 text-white text-sm text-center px-6">
        <p>This match isn't finished yet.</p>
        <p className="text-white/50">Contributors can only submit corrections for finished matches.</p>
        <a href="/contributor" className="text-signal hover:underline">
          Back to dashboard
        </a>
      </main>
    );
  }

  // Editing (result, game result, draft/picks-bans, moment log, OCR) is
  // only allowed once a match is actually live or finished — a scheduled
  // match has nothing real to record yet. The one deliberate exception is
  // the Live Scoreboard's edit/delete-player controls just above, which
  // stay usable even while scheduled so roster mistakes can be fixed
  // before a match goes live.
  const isEditable = match.status !== "scheduled";
  // Phase floors: neither of these made any sense before draft's done
  // (hero picks aren't final) or before the game's actually started
  // (nothing to count yet) — previously clickable in every phase.
  const SCOREBOARD_EDITABLE_PHASES = new Set(["DRAFT_COMPLETE", "GAME_STARTED", "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE"]);
  const OBJECTIVES_EDITABLE_PHASES = new Set(["GAME_STARTED", "GAME_FINISHED", "SERIES_FINISHED", "TECHNICAL_PAUSE"]);
  // A finished game/series needs one extra explicit click before its
  // result data (scoreboard, objectives, hero picks/bans) opens back up
  // for editing — guards against an accidental click quietly altering a
  // result that's already public, without removing the ability to fix a
  // genuine mistake after the fact. Resets whenever the selected game
  // changes so re-opening one finished game doesn't leave another one
  // unlocked too.
  const gameFinished = game?.status === "finished";
  const finishedEditUnlocked = gameFinished && editingFinishedGame;
  const scoreboardEditable = isEditable && SCOREBOARD_EDITABLE_PHASES.has(match.state) && (!gameFinished || finishedEditUnlocked);
  const objectivesEditable = isEditable && OBJECTIVES_EDITABLE_PHASES.has(match.state) && (!gameFinished || finishedEditUnlocked);
  const pickBanEditable = isEditable && (!gameFinished || finishedEditUnlocked);
  const netWorthEditable = isEditable && (!gameFinished || finishedEditUnlocked);

  // "Livestream" below is now reference-only (a normal iframe embed, not
  // wired to capture at all) — the actual OCR/AI capture source is a
  // separate dedicated tab (see startCapture), and the Match capture
  // canvas mirrors whatever that tab shares.
  const embedUrl = youtubeEmbedUrl(match.youtube_url) ?? facebookEmbedUrl(match.youtube_url);
  // The tracker-calibration overlay itself, drawn on top of the Match
  // capture canvas (the raw shared-tab video). Pointer-events only turn on
  // with Tracker edit mode; off, clicks pass through to the video
  // underneath (inert either way — it's just a captured frame, not an
  // interactive player).
  const trackerOverlay =
    match.update_source === "local_ocr" &&
    captureMode === "manual" &&
    ocrDetailsOpen &&
    captureActive &&
    match.state !== "TECHNICAL_PAUSE" ? (
      <div
        className="absolute inset-0"
        style={{ pointerEvents: trackerEditMode ? "auto" : "none" }}
        onMouseDown={(e) => {
          // Two draw-first flows share this canvas: pick-tracker-then-draw
          // (calibratingField already set, writes draftBox) and
          // slide-anywhere draw-then-pick (nothing selected yet, writes
          // pendingBox — a phase/variable picker appears below once it's
          // drawn). Existing region buttons stop propagation on their own
          // mousedown, so clicking one to edit it never falls through to
          // here.
          if (!trackerEditMode) return;
          if (calibratingField && !draftBox) startBoxDrag("draw", e, "draftBox");
          else if (!calibratingField && !pendingBox) startBoxDrag("draw", e, "pendingBox");
        }}
      >
        {trackers
          .filter((t) => (canvasPhaseFilter ? t.phase === canvasPhaseFilter : true))
          .filter(({ field }) => field !== calibratingField)
          .map(({ field, label }) => {
            const box = regions[field];
            if (!box) return null;
            // Tracker edit mode OFF: present but inert — a thin outline
            // only, no click handler, no drag handles, so it never
            // intercepts a click meant for whatever's playing underneath.
            // ON: same clickable box as before (jumps straight into edit
            // mode for the region clicked), just gated behind the toggle
            // now instead of always-on gesture guessing.
            // Small dot, same corner regardless of edit mode — Tesseract's
            // own confidence for this field's most recent read, so a
            // glance at the video shows which regions are reading cleanly
            // (green), shakily (yellow), or not at all (red/gray) without
            // opening the tracker table.
            const dot = (
              <span
                title={`OCR confidence: ${trackerHealth[field]?.confidence != null ? `${Math.round(trackerHealth[field]!.confidence!)}%` : "no read yet"}`}
                className={`absolute w-2 h-2 rounded-full border border-black/40 pointer-events-none ${confidenceColor(trackerHealth[field]?.confidence ?? null)}`}
                style={{ left: `${box.xPct}%`, top: `${box.yPct}%`, transform: "translate(-50%, -50%)" }}
              />
            );
            if (!trackerEditMode) {
              return (
                <Fragment key={field}>
                  <div
                    title={label}
                    className="absolute border border-white/25 pointer-events-none"
                    style={{
                      left: `${box.xPct}%`,
                      top: `${box.yPct}%`,
                      width: `${box.wPct}%`,
                      height: `${box.hPct}%`,
                    }}
                  />
                  {dot}
                </Fragment>
              );
            }
            return (
              <Fragment key={field}>
                {/* Clickable straight from the video instead of only via the
                    small "Resize" button in the field list below — jumps
                    directly into edit mode for whichever region was clicked. */}
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    startCalibrating(field);
                  }}
                  title={`Click to edit: ${label}`}
                  className="absolute border-2 border-white/40 hover:border-signal hover:bg-signal/10 cursor-pointer"
                  style={{
                    left: `${box.xPct}%`,
                    top: `${box.yPct}%`,
                    width: `${box.wPct}%`,
                    height: `${box.hPct}%`,
                  }}
                />
                {dot}
              </Fragment>
            );
          })}
        {/* The region currently being calibrated — live preview, draggable
            body (move) and 4 corner handles (resize). Nothing here
            persists until "Lock" is clicked. */}
        {calibratingField && draftBox && (
          <div
            className="absolute border-2 border-signal bg-signal/10 cursor-move"
            style={{
              left: `${draftBox.xPct}%`,
              top: `${draftBox.yPct}%`,
              width: `${draftBox.wPct}%`,
              height: `${draftBox.hPct}%`,
            }}
            onMouseDown={(e) => startBoxDrag("move", e, "draftBox")}
          >
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <div
                key={corner}
                onMouseDown={(e) => startBoxDrag(corner, e, "draftBox")}
                // 20x20px hit target centered exactly on the corner via
                // translate, regardless of box size — "edge sensitivity"
                // before this was just the 2px border itself, easy to
                // miss on a small region. The visible dot inside stays
                // small.
                className="absolute w-5 h-5 flex items-center justify-center"
                style={{
                  left: corner.includes("w") ? 0 : "100%",
                  top: corner.includes("n") ? 0 : "100%",
                  transform: "translate(-50%, -50%)",
                  cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                }}
              >
                <span className="w-2.5 h-2.5 bg-signal rounded-full border border-white block" />
              </div>
            ))}
          </div>
        )}
        {/* Floating tracker-management panel, positioned right above or
            below the box itself (see regionOverlayPos) instead of only in
            a control strip below the whole canvas. This is now the only
            place add/remove/rename/clear/save-default live — the old
            tracker management table below the video is gone; clicking any
            calibrated box (or finishing a new one) opens this instead. */}
        {calibratingField && draftBox && (() => {
          const tracker = trackers.find((t) => t.field === calibratingField);
          const isRenaming = tracker && trackerLabelDrafts[tracker.id] != null;
          return (
            <div
              className="absolute z-10 flex flex-col gap-1.5 bg-black/80 border border-signal/50 rounded px-2 py-1.5 shadow-lg whitespace-nowrap"
              style={{ left: `${regionOverlayPos(draftBox).left}%`, top: `${regionOverlayPos(draftBox).top}%` }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {isRenaming ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={trackerLabelDrafts[tracker!.id]}
                    onChange={(e) => setTrackerLabelDrafts((prev) => ({ ...prev, [tracker!.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameTracker(tracker!, trackerLabelDrafts[tracker!.id]);
                    }}
                    className="bg-white/10 border border-signal/40 rounded px-1.5 py-0.5 text-xs w-32"
                  />
                  <button onClick={() => renameTracker(tracker!, trackerLabelDrafts[tracker!.id])} className="text-emerald-400 text-xs">✓</button>
                </div>
              ) : (
                <button
                  onClick={() => tracker && setTrackerLabelDrafts((prev) => ({ ...prev, [tracker.id]: tracker.label }))}
                  title="Click to rename"
                  className="text-[11px] font-semibold text-white text-left hover:text-signal"
                >
                  {tracker?.label ?? calibratingField}
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <button onClick={lockDraftBox} className="text-[10px] border border-signal/50 text-signal rounded px-2 py-1 hover:bg-signal/10">
                  🔒 Lock
                </button>
                {regions[calibratingField] && (
                  <button
                    onClick={() => {
                      clearRegionCoords(calibratingField);
                      setDraftBox(null);
                    }}
                    title="Clear calibration (keeps the tracker)"
                    className="text-[10px] border border-white/20 text-white/70 rounded px-2 py-1 hover:bg-white/10"
                  >
                    Clear
                  </button>
                )}
                {tracker && regions[calibratingField] && (
                  <button
                    onClick={() => saveRegionAsTournamentDefault(tracker)}
                    title="New matches in this tournament will start with this tracker already calibrated"
                    className="text-[10px] border border-white/20 text-white/70 rounded px-2 py-1 hover:bg-white/10"
                  >
                    {savedDefaultField === tracker.field ? "Saved ✓" : "Save default"}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (tracker) removeTracker(tracker);
                    cancelDraftBox();
                  }}
                  title="Remove this tracker entirely"
                  className="text-[10px] border border-white/20 text-white/70 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
                >
                  Remove
                </button>
                <button onClick={cancelDraftBox} className="text-[10px] border border-white/20 text-white/70 rounded px-2 py-1 hover:bg-white/10">
                  Cancel
                </button>
              </div>
            </div>
          );
        })()}
        {/* Not yet drawn at all — a one-line hint since the empty
            container gives no other cue to click-drag. */}
        {calibratingField && !draftBox && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Click and drag to draw the region</span>
          </div>
        )}

        {/* Slide-anywhere: a brand-new box drawn without a tracker picked
            yet — the phase/variable picker below assigns it once drawn. */}
        {!calibratingField && pendingBox && (
          <div
            className="absolute border-2 border-signal bg-signal/10 cursor-move"
            style={{
              left: `${pendingBox.xPct}%`,
              top: `${pendingBox.yPct}%`,
              width: `${pendingBox.wPct}%`,
              height: `${pendingBox.hPct}%`,
            }}
            onMouseDown={(e) => startBoxDrag("move", e, "pendingBox")}
          >
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <div
                key={corner}
                onMouseDown={(e) => startBoxDrag(corner, e, "pendingBox")}
                className="absolute w-5 h-5 flex items-center justify-center"
                style={{
                  left: corner.includes("w") ? 0 : "100%",
                  top: corner.includes("n") ? 0 : "100%",
                  transform: "translate(-50%, -50%)",
                  cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                }}
              >
                <span className="w-2.5 h-2.5 bg-signal rounded-full border border-white block" />
              </div>
            ))}
          </div>
        )}
        {/* Floating variable picker + Save/Cancel, positioned right next
            to the freshly-drawn box (see regionOverlayPos) instead of
            only in a strip below the whole canvas — same "controls live
            next to what they act on" fix as the calibratingField panel
            above. */}
        {!calibratingField && pendingBox && (
          <div
            className="absolute z-10 flex flex-wrap items-center gap-1.5 bg-black/80 border border-signal/50 rounded px-2 py-1.5 shadow-lg"
            style={{ left: `${regionOverlayPos(pendingBox).left}%`, top: `${regionOverlayPos(pendingBox).top}%`, maxWidth: "44%" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <span className="text-[10px] text-white/50 uppercase tracking-wider whitespace-nowrap">New tracker</span>
            <select
              value={pendingBoxPhase}
              onChange={(e) => {
                setPendingBoxPhase(e.target.value);
                setPendingBoxField("");
              }}
              className="bg-white/10 border border-white/10 rounded px-1.5 py-1 text-[10px]"
            >
              {TRACKER_PHASES.map((p) => (
                <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
              ))}
            </select>
            <select
              value={pendingBoxField}
              onChange={(e) => setPendingBoxField(e.target.value)}
              className="bg-white/10 border border-white/10 rounded px-1.5 py-1 text-[10px] min-w-[140px]"
            >
              <option value="">
                {pendingBoxOptions.length === 0 ? "Nothing left to track" : "Select a variable..."}
              </option>
              {pendingBoxOptions.map((opt) => (
                <option key={opt.field} value={opt.field}>{opt.label}</option>
              ))}
            </select>
            <button
              onClick={savePendingBox}
              disabled={!pendingBoxField}
              className="text-[10px] border border-signal/50 text-signal rounded px-2 py-1 hover:bg-signal/10 disabled:opacity-40"
            >
              Save
            </button>
            <button onClick={cancelPendingBox} className="text-[10px] border border-white/20 text-white/70 rounded px-2 py-1 hover:bg-white/10">
              Cancel
            </button>
          </div>
        )}
        {!calibratingField && !pendingBox && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Drag anywhere to place a new tracker</span>
          </div>
        )}
      </div>
    ) : null;
  // Captured area — drawn on top of trackerOverlay so it's visible (as a
  // yellow guide outline) while placing/adjusting trackers even when it's
  // not actively being edited. Only intercepts clicks while
  // captureAreaEditMode is on; otherwise pointer-events pass straight
  // through to trackerOverlay/the video underneath, same as every other
  // inert overlay box on this canvas.
  const captureAreaOverlay =
    match.update_source === "local_ocr" && captureMode === "manual" && ocrDetailsOpen && captureActive && match.state !== "TECHNICAL_PAUSE" ? (
      <div
        className="absolute inset-0"
        style={{ pointerEvents: captureAreaEditMode ? "auto" : "none" }}
        onMouseDown={(e) => {
          if (!captureAreaEditMode || captureAreaDraft) return;
          startCaptureAreaDrag("draw", e);
        }}
      >
        {!captureAreaEditMode && captureArea && (
          <div
            title="Captured area — trackers and screenshots are kept inside this boundary"
            className="absolute border-2 border-dashed border-yellow-400/50 pointer-events-none"
            style={{ left: `${captureArea.xPct}%`, top: `${captureArea.yPct}%`, width: `${captureArea.wPct}%`, height: `${captureArea.hPct}%` }}
          />
        )}
        {captureAreaEditMode && captureAreaDraft && (
          <div
            className="absolute border-2 border-dashed border-yellow-400 bg-yellow-400/10 cursor-move"
            style={{ left: `${captureAreaDraft.xPct}%`, top: `${captureAreaDraft.yPct}%`, width: `${captureAreaDraft.wPct}%`, height: `${captureAreaDraft.hPct}%` }}
            onMouseDown={(e) => startCaptureAreaDrag("move", e)}
          >
            <span className="absolute -top-5 left-0 text-[10px] text-yellow-300 bg-black/70 px-1 rounded whitespace-nowrap">
              Captured area
            </span>
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <div
                key={corner}
                onMouseDown={(e) => startCaptureAreaDrag(corner, e)}
                className="absolute w-5 h-5 flex items-center justify-center"
                style={{
                  left: corner.includes("w") ? 0 : "100%",
                  top: corner.includes("n") ? 0 : "100%",
                  transform: "translate(-50%, -50%)",
                  cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                }}
              >
                <span className="w-2.5 h-2.5 bg-yellow-400 rounded-full border border-black block" />
              </div>
            ))}
          </div>
        )}
        {captureAreaEditMode && !captureAreaDraft && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs text-white/70 bg-black/60 px-2 py-1 rounded">Drag to draw the captured area</span>
          </div>
        )}
      </div>
    ) : null;
  const activeTrackers = trackers.filter((t) => t.phase === match.state);
  const allTrackersCalibrated = activeTrackers.length > 0 && activeTrackers.every((t) => regions[t.field]);
  // "Every indicator is red right after Game ongoing starts" diagnostic —
  // every active tracker has gone at least 15s (three ticks) with no
  // successful read despite capture running and every field calibrated.
  // The single most common real cause: the regions were calibrated
  // against a different capture layout than what's on screen right now
  // (a different window/tab picked this session, different resolution,
  // or the picked source shows something other than the broadcast, e.g.
  // a black loading screen during the Game ongoing transition) — every
  // crop lands on blank space at once, which reads exactly like this.
  // Surfaced as a banner with a concrete next step rather than a
  // perpetual silent red, since there's nothing else on this page that
  // explains a stuck-red tracker.
  const NO_READ_STALE_MS = 15_000;
  const allTrackersUnhealthy =
    captureActive &&
    captureMode === "manual" &&
    allTrackersCalibrated &&
    captureStartedAtRef.current != null &&
    Date.now() - captureStartedAtRef.current > NO_READ_STALE_MS &&
    activeTrackers.every((t) => {
      const h = trackerHealth[t.field];
      return !h?.lastGoodAt || Date.now() - h.lastGoodAt > NO_READ_STALE_MS;
    });
  // Auto-collapse: see the preGuardAllTrackersCalibrated effect declared
  // above the loading guard near the top of this component (has to live
  // there, not here, to satisfy the Rules of Hooks).

  // The starting five for this game = whoever has a logged pick, not the
  // whole roster (which included bench/subs never playing this game —
  // the source of "mistakenly taking other data than players"). Falls
  // back to the full roster, sorted the same way, until picks are logged
  // so the admin has someone to pick from. Also always includes anyone
  // with a player_stats row for this game even without a pick — this is
  // what makes the "add player" button below actually work for a
  // substitute who came in without a hero pick ever being logged for
  // them. Both always sort left-to-right by role: exp lane, jungler, mid
  // laner, gold laner, roamer.
  // Match-local custom players (added in Hero picks & bans, see
  // addCustomPlayerToPick) as synthetic Player-shaped rows — id is
  // `custom:<pick-ban row id>` (see isCustomPlayerId), never a real
  // players.id, so they never collide with an actual roster player and
  // every consumer that branches on that prefix (updateStat/ensureStatRow)
  // treats them consistently. This is what makes the Live Scoreboard's
  // player list driven by who's actually in this game's Hero picks & bans
  // instead of only the `players` table roster — a custom player who was
  // never added to that table still shows up here because they have a
  // pickBans row for this game.
  const customPlayers: Player[] = pickBans
    .filter((pb) => pb.type === "pick" && pb.custom_player_name)
    .map((pb) => ({
      id: `custom:${pb.id}`,
      team_id: pb.team_id,
      ign: pb.custom_player_name!,
      role: pb.custom_player_role,
      photo_url: null,
      is_active_roster: true,
    }));
  const effectivePlayers: Player[] = [...players, ...customPlayers];
  function activeFive(teamId: string | undefined) {
    if (!teamId) return [];
    // Before the draft has actually started there's no "who's playing"
    // decided yet — the Live Scoreboard should show nothing rather than a
    // preset roster guess that may not match who ends up picked.
    if (match?.state === "MATCH_NOT_STARTED") return [];
    const pickedIds = new Set(
      pickBans
        .filter((pb) => pb.type === "pick" && pb.team_id === teamId && (pb.player_id || pb.custom_player_name))
        .map((pb) => pb.player_id ?? `custom:${pb.id}`)
    );
    const statIds = new Set(
      stats
        .map((s) => {
          if (s.player_id) return s.player_id;
          if (!s.custom_player_name) return null;
          const pb = pickBans.find((row) => row.custom_player_name === s.custom_player_name);
          return pb ? `custom:${pb.id}` : null;
        })
        .filter((id): id is string => !!id)
    );
    // is_active_roster is the roster editor's own "which 5" decision — a
    // player flagged active shows here even before any pick/stat row
    // exists, which is what makes the roster show up on the Live
    // Scoreboard as soon as Draft starts, not only once a pick or a KDA
    // edit has actually happened. Picked/statted players stay included
    // too so a genuine mid-game substitution (added via "+ Add" below,
    // which isn't itself an is_active_roster flip) still renders — a
    // benched sub who's neither flagged active nor actually in the game
    // is the only thing this excludes. Custom players are always
    // is_active_roster: true by construction, so they fall into the same
    // branch as a flagged real roster player.
    const activeRosterIds = new Set(effectivePlayers.filter((p) => p.team_id === teamId && p.is_active_roster).map((p) => p.id));
    const included = effectivePlayers.filter((p) => p.team_id === teamId && (activeRosterIds.has(p.id) || pickedIds.has(p.id) || statIds.has(p.id)));
    // Fallback before any pick/stat/is_active_roster signal exists yet —
    // the same role-ordered top 5 lockInPositionalPicks/draftFullyResolved
    // treat as "the starting five," never the whole team roster. The whole
    // roster used to be the fallback here, which meant any bench player
    // (a 6th+ name on the team) showed up on the Live Scoreboard the
    // instant nothing else had "claimed" the 5 slots yet.
    const base =
      included.length > 0
        ? included
        : effectivePlayers.filter((p) => p.team_id === teamId);
    // is_active_roster defaults to true for every existing player (see the
    // migration), so a team with more than 5 signed players shows every
    // one of them here until someone benches the extras — capped at 5,
    // role-order, matching the exact same "starting five" every other
    // draft-locking function on this page assumes. The roster set before
    // the draft starts is the final list; this is what actually enforces
    // that on the Live Scoreboard, not just the "+ Add player" gate.
    return [...base].sort((a, b) => roleIndex(a.role) - roleIndex(b.role)).slice(0, 5);
  }
  const teamAPlayers = activeFive(match.team_a?.id);
  const teamBPlayers = activeFive(match.team_b?.id);
  const rosterFor = (teamId: string) => players.filter((p) => p.team_id === teamId);
  // Same positional-fallback DraftOverlay uses internally (see its file
  // comment) — a team's Nth still-unassigned pick (by pick_order) matches
  // that team's Nth player in `orderedTeamPlayers` (role-ordered, same as
  // teamAPlayers/teamBPlayers). Shared here so the Live Scoreboard's
  // read-only-once-picked gate agrees with what the Draft board is
  // already showing, instead of only recognizing a *real* player_id and
  // treating every positionally-matched (not yet explicitly swapped) pick
  // as if it didn't exist.
  function effectivePickFor(playerId: string, teamId: string, orderedTeamPlayers: { id: string }[]): PickBan | undefined {
    const real = pickBans.find((pb) => pb.type === "pick" && pb.player_id === playerId);
    if (real) return real;
    const idx = orderedTeamPlayers.findIndex((p) => p.id === playerId);
    if (idx === -1) return undefined;
    const unassigned = pickBans
      .filter((pb) => pb.type === "pick" && pb.team_id === teamId && !pb.player_id)
      .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
    let unassignedIdx = 0;
    for (let i = 0; i < idx; i++) {
      const hasReal = pickBans.some((pb) => pb.type === "pick" && pb.player_id === orderedTeamPlayers[i].id);
      if (!hasReal) unassignedIdx++;
    }
    return unassigned[unassignedIdx];
  }
  // Same custom-vs-real branch as ensureStatRow/updateStat, for the read
  // side — every scoreboard row's stat lookup goes through this instead of
  // a raw `stats.find(s => s.player_id === p.id)`, which would never match
  // a custom player (their stat rows carry custom_player_name, not
  // player_id).
  function statForPlayer(p: Player): PlayerStat | undefined {
    if (isCustomPlayerId(p.id)) {
      const name = customPlayerNameFor(p.id);
      return stats.find((s) => s.custom_player_name === name);
    }
    return stats.find((s) => s.player_id === p.id);
  }

  // ── Draft overlay (broadcast-style) derived values ────────────────────
  // Left/right follows the draft simulation's own Blue/Red assignment once
  // it's running (Blue conventionally shown on the left) — before it
  // starts, or once it's cleared post-draft, falls back to the same
  // left/right calibration the OCR tracker above already uses, so the
  // overlay doesn't flip sides relative to the rest of this page.
  function teamById(teamId: string | null | undefined) {
    if (!teamId) return null;
    return match?.team_a?.id === teamId ? match.team_a : match?.team_b?.id === teamId ? match.team_b : null;
  }
  const overlayLeftTeamId = draftSim?.blueTeamId ?? resolveLeftTeamId();
  const overlayRightTeamId = draftSim?.redTeamId ?? resolveRightTeamId();
  const overlayLeftTeam = teamById(overlayLeftTeamId);
  const overlayRightTeam = teamById(overlayRightTeamId);
  const overlayLeftPlayers = activeFive(overlayLeftTeamId ?? undefined);
  const overlayRightPlayers = activeFive(overlayRightTeamId ?? undefined);
  const overlayTurn = draftSim ? DRAFT_SEQUENCE[draftSim.stepIndex] : null;
  const overlayTurnSide: "left" | "right" | null = overlayTurn
    ? (overlayTurn.side === "blue" ? draftSim!.blueTeamId : draftSim!.redTeamId) === overlayLeftTeamId
      ? "left"
      : "right"
    : null;
  const overlayPhaseLabel = draftSim
    ? overlayTurn!.type === "ban"
      ? "BANNING"
      : "PICKING"
    : match.state === "DRAFT_COMPLETE"
    ? "FINAL ADJUSTMENTS"
    : match.state === "GAME_STARTED"
    ? "LIVE — CORRECTIONS"
    : "DRAFT PHASE";
  const overlayStageLabel = `${match.tournament?.name ?? "Draft"} · Game ${game.game_number}`;
  const overlayTurnLabel = draftSim ? draftStepLabel(draftSim.stepIndex) : null;
  const overlayStepProgress = draftSim ? `${draftSim.stepIndex + 1}/${DRAFT_SEQUENCE.length}` : null;
  function heroIconFor(heroName: string) {
    return heroes.find((h) => h.name === heroName)?.icon_url ?? null;
  }

  async function toggleActiveRoster(playerId: string, next: boolean) {
    const { error } = await supabase.from("players").update({ is_active_roster: next }).eq("id", playerId);
    if (error) {
      setError(error.message);
      return;
    }
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, is_active_roster: next } : p)));
  }

  // ── Pre-draft roster setup ─────────────────────────────────────────
  // Fixing a typo'd IGN or a wrong role used to mean leaving this page for
  // /admin/players, then coming back — a real problem the moment before a
  // draft starts, when a sub or a corrected spelling needs to be right
  // before it shows up on the broadcast-style board above. Scoped to
  // renaming/re-rolling an existing roster row only, not adding brand-new
  // players to a team — that's still a /admin/players (or /admin/teams)
  // job, out of scope for a per-match console. (editingRosterPlayerId/Ign/Role
  // state itself is declared above the loading guard near the top of this
  // component — see the comment there.)
  function startEditRosterPlayer(p: Player) {
    setEditingRosterPlayerId(p.id);
    setEditingRosterIgn(p.ign);
    setEditingRosterRole(p.role ?? "");
  }
  async function saveRosterPlayerEdit(playerId: string) {
    const ign = editingRosterIgn.trim();
    if (!ign) return;
    const role = editingRosterRole || null;
    const { error } = await supabase.from("players").update({ ign, role }).eq("id", playerId);
    if (error) {
      setError(error.message);
      return;
    }
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, ign, role } : p)));
    setEditingRosterPlayerId(null);
  }
  // Genuine roster add/remove, not just the bench/activate toggle above —
  // for a brand-new sub who isn't in the players table at all yet, or a
  // player who's left the team and shouldn't show up as an option anymore.
  // `players` is the team's persistent roster (shared across every match
  // that team plays), so both of these are real roster changes, not
  // something scoped to just this match — matches how a real roster
  // change (a transfer, a departure) actually works. (newRosterName state
  // itself is declared above the loading guard near the top of this
  // component — see the comment there.)
  async function addRosterPlayer(teamId: string) {
    const ign = (newRosterName[teamId] ?? "").trim();
    if (!ign) return;
    const { data, error } = await supabase
      .from("players")
      .insert({ team_id: teamId, ign, role: null, is_active_roster: true })
      .select("id, team_id, ign, role, photo_url, is_active_roster")
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setPlayers((prev) => [...prev, data as Player]);
    setNewRosterName((prev) => ({ ...prev, [teamId]: "" }));
  }
  // Deletes the players row outright. If this player has picks/stats
  // attached from a PAST match, Postgres' own foreign-key constraint
  // rejects the delete — surfaced via the normal error toast instead of
  // silently orphaning history, rather than this trying to pre-guess
  // every table that might reference them.
  async function removeRosterPlayer(p: Player) {
    if (!confirm(`Remove ${p.ign} from the roster entirely? This is a team-wide change, not just this match.`)) return;
    const { error } = await supabase.from("players").delete().eq("id", p.id);
    if (error) {
      setError(`Couldn't remove ${p.ign}: ${error.message}`);
      return;
    }
    setPlayers((prev) => prev.filter((row) => row.id !== p.id));
  }
  // A direct "team_kills" OCR tracker (see captureTickBody) overrides this
  // once it's read anything — falls back to summing player_stats.kills
  // (the only source before that tracker existed, and still the only
  // source for Normal/Liquipedia-sourced matches).
  // effectivePlayers (not raw `players`) so a custom player's kills still
  // count toward their team's total — their stat row has no player_id to
  // match against a `players` row.
  function statOwnerTeamId(s: PlayerStat): string | undefined {
    if (s.player_id) return effectivePlayers.find((p) => p.id === s.player_id)?.team_id;
    return effectivePlayers.find((p) => p.ign === s.custom_player_name)?.team_id;
  }
  // Math.max, not `??` — the OCR team-kills tracker (team_a_kills_override)
  // updates independently of the per-player K/D/A trackers, and can settle
  // on a real-but-stale value (including 0, which `??` would trust forever
  // since 0 isn't null). Team kills can never be less than what's already
  // individually attributed to that team's players — enforcing that
  // relationship directly means a lagging override self-heals the moment
  // per-player kills catch up or pass it, instead of freezing this sticky
  // header's count while the Live scoreboard section below (computedTeam*
  // Kills, a pure sum) keeps climbing.
  const teamAKillsTotal = Math.max(
    game?.team_a_kills_override ?? 0,
    stats.filter((s) => statOwnerTeamId(s) === match.team_a?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0)
  );
  const teamBKillsTotal = Math.max(
    game?.team_b_kills_override ?? 0,
    stats.filter((s) => statOwnerTeamId(s) === match.team_b?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0)
  );
  // Live scoreboard's own "Team kills" readout — strictly the sum of that
  // team's players' kills (no override), cross-checked against the enemy's
  // summed deaths: every kill is someone else's death, so the two must
  // match exactly (both start at 0-0 and reconcile trivially before any
  // kill is logged — TBD rows count as 0, same as the KDA inputs already
  // treat them). Never rendered when this doesn't hold — a genuine
  // mismatch means a KDA entry is wrong, not a number to show and trust.
  const teamADeathsTotal = stats.filter((s) => statOwnerTeamId(s) === match.team_a?.id).reduce((sum, s) => sum + (s.deaths ?? 0), 0);
  const teamBDeathsTotal = stats.filter((s) => statOwnerTeamId(s) === match.team_b?.id).reduce((sum, s) => sum + (s.deaths ?? 0), 0);
  const computedTeamAKills = stats.filter((s) => statOwnerTeamId(s) === match.team_a?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const computedTeamBKills = stats.filter((s) => statOwnerTeamId(s) === match.team_b?.id).reduce((sum, s) => sum + (s.kills ?? 0), 0);
  const teamKillsValid = computedTeamAKills === teamBDeathsTotal && computedTeamBKills === teamADeathsTotal;
  async function addScoreboardPlayer(playerId: string) {
    await ensureStatRow(playerId);
    loadAll();
  }

  return (
    <div className="text-white space-y-8" style={{ "--lv-admin-header-h": `${adminHeaderH}px` } as CSSPropertiesWithVars}>
      {/* Sticky — phase changes and the stream link are the two things an
          admin needs reachable no matter how far down the page they've
          scrolled (moment log, scoreboard, calibration UI are all long).
          Its rendered height is measured below (adminHeaderH) so the
          monitor pane's own sticky offset can sit exactly below it
          instead of guessing a fixed pixel value against wrapping text. */}
      <div ref={adminHeaderRef} className="sticky top-0 z-20 bg-ink/95 backdrop-blur border-b border-white/10 pb-3 -mx-6 px-6">
        <h1 className="lv-heading text-lg flex items-center gap-2.5 flex-wrap">
          {/* Each team's own little "live-score box" — logo + name, with
              the last-captured net worth pinned to its top-right corner
              (raw last-read value, not recomputed — see formatGold) and
              the kills score in between. Lives in the sticky header
              (rather than only in the Team kills/Net worth sections
              further down the page) specifically so it — and the team
              kills count — never scrolls out of view, per the "kills
              counter stays visible" ask. Liquipedia/Normal matches have
              neither net worth nor a local kills tracker, so this stays
              a plain name row for those. */}
          {match.update_source === "local_ocr" ? (
            <>
              <span className="relative inline-flex items-center gap-1.5 border border-white/10 rounded px-2 py-1">
                <TeamLogo url={match.team_a?.logo_url} size="sm" />
                {match.team_a?.name}
                {latestNetWorth?.team_a_gold != null && (
                  <span
                    className="absolute -top-2 -right-2 text-[9px] font-mono tabular-nums bg-signal text-white rounded px-1 py-0.5 leading-none shadow"
                    title="Last-captured net worth"
                  >
                    {formatGold(latestNetWorth.team_a_gold)}
                  </span>
                )}
              </span>
              <span className={`text-base font-bold tabular-nums ${teamAKillsTotal > teamBKillsTotal ? "text-signal" : "text-white/70"}`}>
                {teamAKillsTotal}
              </span>
              <span className="text-white/30 text-sm">–</span>
              <span className={`text-base font-bold tabular-nums ${teamBKillsTotal > teamAKillsTotal ? "text-signal" : "text-white/70"}`}>
                {teamBKillsTotal}
              </span>
              <span className="relative inline-flex items-center gap-1.5 border border-white/10 rounded px-2 py-1">
                {match.team_b?.name}
                <TeamLogo url={match.team_b?.logo_url} size="sm" />
                {latestNetWorth?.team_b_gold != null && (
                  <span
                    className="absolute -top-2 -right-2 text-[9px] font-mono tabular-nums bg-signal text-white rounded px-1 py-0.5 leading-none shadow"
                    title="Last-captured net worth"
                  >
                    {formatGold(latestNetWorth.team_b_gold)}
                  </span>
                )}
              </span>
            </>
          ) : (
            <>
              <TeamLogo url={match.team_a?.logo_url} size="sm" />
              {match.team_a?.name} vs {match.team_b?.name}
              <TeamLogo url={match.team_b?.logo_url} size="sm" />
            </>
          )}
        </h1>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <p className="text-xs text-white/50">
            {match.tournament?.liquipedia_slug ? (
              <a
                href={`/tournaments/${match.tournament.liquipedia_slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white underline"
              >
                {match.tournament?.name}
              </a>
            ) : (
              match.tournament?.name
            )}{" "}
            · {match.format} · Game {game.game_number}
          </p>
          <input
            defaultValue={match.youtube_url ?? ""}
            onBlur={async (e) => {
              const url = e.target.value.trim();
              if (url === (match.youtube_url ?? "")) return;
              const { error } = await supabase.from("matches").update({ youtube_url: url || null }).eq("id", match.id);
              if (error) setError(error.message);
              else loadAll();
            }}
            placeholder="Livestream URL (YouTube or Facebook)"
            className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs w-56"
          />
          {phaseSignals && (
            <PhaseStepper
              transitions={phaseTransitions}
              current={match.state as MatchPhase}
              onSelect={(phase) => handlePhaseChange(phase)}
              disabled={isContributor}
            />
          )}
          {/* Match status — previously only settable from the admin/matches
              list, so an admin already deep in the live console had to leave
              it to flip status, and everything below stayed locked
              (isEditable) until they did. Same "Live needs a stream link"
              rule as the matches list. */}
          {!isContributor && (
            <div className="flex items-center gap-1" title="Match status — controls whether this console is locked (see the notice below the phase row)">
              {(["scheduled", "live", "finished"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => updateMatchStatus(s)}
                  disabled={statusSaving || match.status === s || (s === "live" && !match.youtube_url)}
                  title={s === "live" && !match.youtube_url ? "Add a stream link first — a match can't go live without one" : undefined}
                  // Slightly taller tap target below sm — scheduled/live/
                  // finished is one of the most-tapped controls while
                  // covering a match, and py-0.5 (2px) reads fine on a
                  // mouse but is a genuinely hard target on touch. sm:
                  // restores the exact original py-0.5.
                  className={`text-[10px] px-2 py-1.5 sm:py-0.5 rounded border uppercase tracking-wide disabled:opacity-40 ${
                    match.status === s
                      ? s === "live"
                        ? "border-signal bg-signal/20 text-signal"
                        : s === "finished"
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400"
                        : "border-white/30 bg-white/10 text-white"
                      : "border-white/10 text-white/40 hover:bg-white/10 hover:text-white/70"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {!isContributor && (
            <select
              value={displayMatchTier(match)}
              onChange={(e) => setMatchTier(e.target.value as MatchTier)}
              title="Normal: Liquipedia auto-sync, no automatic posts. Priority: Liquipedia auto-sync, match-started/finished posts only. Hot: fully admin/OCR-controlled, every automatic trigger."
              className={`text-[10px] px-2 py-0.5 rounded border bg-transparent ${
                displayMatchTier(match) === "hot"
                  ? "border-signal/50 text-signal"
                  : displayMatchTier(match) === "priority"
                  ? "border-amber-400/50 text-amber-300"
                  : "border-emerald-500/40 text-emerald-400"
              }`}
            >
              {(Object.keys(MATCH_TIER_LABELS) as MatchTier[]).map((tier) => (
                <option key={tier} value={tier}>{MATCH_TIER_LABELS[tier]}</option>
              ))}
            </select>
          )}
          <button onClick={shareFullMatchInfo} className="text-[10px] border border-white/10 rounded px-2 py-0.5 hover:bg-white/10">
            📢 Share everything to Telegram
          </button>
          {!isContributor && (
            <button
              onClick={resetMatch}
              disabled={!isEditable}
              title={
                isEditable
                  ? "Deletes all games, picks/bans, stats, and objectives for this match and reverts it to Match not started"
                  : "Not available while the match is scheduled — nothing to reset yet"
              }
              className="text-[10px] border border-red-500/30 text-red-400 rounded px-2 py-0.5 hover:bg-red-500/10 disabled:opacity-40"
            >
              ⟲ Reset match
            </button>
          )}
        </div>
        {match.state === "SERIES_FINISHED" && (
          <p className="text-sm text-emerald-400 mt-2">
            Series finished — winner: {match.series_winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
          </p>
        )}
        {forceWinnerPrompt && match.team_a && match.team_b && (
          <div className="mt-3 border border-signal/40 bg-signal/10 rounded p-3 space-y-2">
            <p className="text-sm text-signal font-semibold">Which team won Game {game.game_number}?</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  declareGameWinner(match.team_a!.id);
                  setForceWinnerPrompt(false);
                }}
                className="lv-btn-ghost !px-3 !py-1.5"
              >
                {match.team_a.name}
              </button>
              <button
                onClick={() => {
                  declareGameWinner(match.team_b!.id);
                  setForceWinnerPrompt(false);
                }}
                className="lv-btn-ghost !px-3 !py-1.5"
              >
                {match.team_b.name}
              </button>
              <button onClick={() => setForceWinnerPrompt(false)} className="text-xs text-white/40 hover:text-white/70">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Split ratio control — two numbers, min 20 each, always summing to
          100 (changing one adjusts the other automatically). Replaces the
          old fixed 60/40 split; each pane below gets its own independent
          bordered box now (see the "why two boxes, not one" note below)
          instead of sharing one outer border that stretched the shorter
          pane's box down to match the taller one, leaving a dead gap. */}
      <div className="flex items-center gap-2 mb-2 text-xs text-white/50">
        <span>Monitor / action deck split</span>
        <input
          type="number"
          min={20}
          max={80}
          value={splitLeftPct}
          onChange={(e) => applySplit(Number(e.target.value) || splitLeftPct)}
          className="w-14 bg-white/10 border border-white/10 rounded px-1.5 py-1 text-center"
        />
        <span>–</span>
        <input
          type="number"
          min={20}
          max={80}
          value={100 - splitLeftPct}
          onChange={(e) => applySplit(100 - (Number(e.target.value) || 100 - splitLeftPct))}
          className="w-14 bg-white/10 border border-white/10 rounded px-1.5 py-1 text-center"
        />
        <button
          onClick={() => applySplit(60)}
          className="text-white/40 hover:text-white/70 underline underline-offset-2"
        >
          Reset to 60–40
        </button>
      </div>

      {/* THE MONITOR + ACTION DECK — two independently-boxed panes instead
          of one shared bordered container around both. A shared border
          around a CSS grid row forces it to the height of the *taller*
          cell — since the action deck (everything below the video/OCR
          tools) runs far longer than the monitor pane's own content, that
          left a large dead gap under the monitor, inside the same border,
          down to wherever the action deck happened to end. Two separate
          boxes means each one's border ends exactly at its own content —
          no shared row height to fight. */}
      <div className="grid grid-cols-1 lg:grid-cols-[var(--lv-split-left)_var(--lv-split-right)] gap-4" style={{ "--lv-split-left": `${splitLeftPct}fr`, "--lv-split-right": `${100 - splitLeftPct}fr` } as CSSPropertiesWithVars}>
        {/* THE MONITOR — livestream + OCR capture. Sticky on large screens
            so the stream never scrolls out of view while the action deck
            scrolls independently beside it. Its own rounded border now —
            ends right where its content ends, doesn't stretch to match
            the action deck's height. */}
        <div
          className="flex flex-col rounded-lg border border-white/10 w-full max-w-full lg:sticky lg:top-[calc(var(--lv-admin-header-h,0px)+1px)] lg:max-h-[calc(100vh-var(--lv-admin-header-h,0px)-1px)]"
          style={{
            width: "100%",
          }}
        >
          {/* Declare Game Winner + game/map selector — moved to the very
              top of the monitor pane, above the livestream itself, so the
              controls an admin reaches for constantly (who won, which
              game/map is being edited) are visible without scrolling past
              the video. Moved from the action deck below. */}
          <div className="p-3 lg:p-4 pb-0 shrink-0 space-y-3">
            {!DRAFT_PHASES.includes(match.state) && game.status === "live" && !gameFinished && (
              <section className="space-y-2 bg-white/5 rounded p-3 border border-white/10">
                <h3 className="font-semibold text-sm">Declare Game Winner</h3>
                <div className="flex gap-2 flex-wrap">
                  {[match.team_a, match.team_b].map((team) =>
                    team ? (
                      <button
                        key={team.id}
                        onClick={() => declareGameWinner(team.id)}
                        className={`text-xs px-3 py-1.5 rounded font-semibold transition-colors ${
                          game.winner_team_id === team.id
                            ? "bg-signal text-white"
                            : "border border-white/20 hover:bg-white/10"
                        }`}
                      >
                        🏆 {team.name}
                      </button>
                    ) : null
                  )}
                </div>
              </section>
            )}
            {(() => {
              const MAX_GAMES_FOR_FORMAT: Record<string, number> = { BO1: 1, BO2: 2, BO3: 3, BO5: 5, BO7: 7 };
              const maxGames = MAX_GAMES_FOR_FORMAT[match.format ?? "BO3"] ?? 3;
              const knownNumbers = new Set([...pastGames.map((g) => g.game_number), game.game_number]);
              const allNumbers = Array.from({ length: Math.max(maxGames, ...knownNumbers) }, (_, i) => i + 1);
              const gameLabel = (n: number) => {
                if (n === match.current_game_number) return `Game ${n} — Live`;
                const found = pastGames.find((g) => g.game_number === n);
                if (found?.winner_team_id) {
                  const winnerName = found.winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name;
                  return `Game ${n} — Finished (${winnerName})`;
                }
                if (found) return `Game ${n} — Finished`;
                if (n === game.game_number) return `Game ${n} — Editing`;
                return `Game ${n} — Upcoming`;
              };
              return (
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-xs text-white/50">Viewing / editing</label>
                  <select
                    value={game.game_number}
                    onChange={(e) => setSelectedGameNumber(Number(e.target.value))}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm"
                  >
                    {allNumbers.map((n) => (
                      <option key={n} value={n}>
                        {gameLabel(n)}
                      </option>
                    ))}
                  </select>
                  {game.game_number !== match.current_game_number && (
                    <>
                      <span className="lv-badge bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        Not the live game — phase controls below still act on the live match state
                      </span>
                      <button
                        onClick={() => setSelectedGameNumber(match.current_game_number)}
                        className="text-xs border border-signal/50 text-signal rounded px-2 py-1 hover:bg-signal/10 font-semibold"
                        title="This normally follows automatically when a game finishes and the next one starts — use this if it doesn't."
                      >
                        ↦ Jump to live (Game {match.current_game_number})
                      </button>
                    </>
                  )}
                </div>
              );
            })()}
            <section className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-white/50">Map</label>
                <select
                  value={game.map ?? ""}
                  onChange={(e) => setGameMap(e.target.value)}
                  disabled={!isEditable}
                  className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm disabled:opacity-40"
                >
                  <option value="">Not set</option>
                  {MAPS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {game.status === "finished" && (
                <div className="flex items-center gap-2">
                  <span className="lv-badge bg-emerald-500/15 text-emerald-400">
                    Game {game.game_number} winner: {game.winner_team_id === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
                  </span>
                  {isEditable && match.team_a && match.team_b && (
                    <span className="flex gap-1">
                      {[match.team_a, match.team_b].map((t) =>
                        t.id === game.winner_team_id ? null : (
                          <button
                            key={t.id}
                            onClick={() => correctGameWinner(game.id, t.id)}
                            className="text-xs text-white/30 hover:text-signal"
                            title={`Correct: ${t.name} actually won Game ${game.game_number}`}
                          >
                            → {t.name}
                          </button>
                        )
                      )}
                    </span>
                  )}
                </div>
              )}
            </section>
          </div>
          {/* Match capture — deliberately NOT part of the scrollable area
              below, so it never scrolls out of view while everything else
              in this pane does. "Start capture" now shares a SEPARATE,
              dedicated tab (see startCapture) instead of this admin page
              itself — that tab can go fullscreen purely for read accuracy,
              independent of whatever width this pane's own layout gives
              it, and keeps rendering at full rate even while backgrounded
              (Chrome doesn't throttle a tab it knows is being actively
              screen-captured). No more self-capture recursion risk either,
              since there's no "wrong tab" that's actually this one.
              Calibration drags directly on this raw video; every box's
              coordinates are already whole-frame percentages
              (toFullFramePct/cropVideoToEmbed treat embedFrame as null,
              since nothing sets it anymore — this replaces the old
              embed-relative cropping entirely, not just as a fallback). */}
          <div className="p-3 lg:p-4 pb-0 shrink-0 space-y-2">
            <h3 className="font-semibold text-sm">Match capture</h3>
            <div
              data-crop-container
              className="relative w-full border border-white/10 rounded overflow-hidden select-none bg-white/5 min-h-[120px]"
            >
              <video ref={previewRef} muted className="w-full block" />
              {!captureActive && (
                <div className="absolute inset-0 flex items-center justify-center text-white/30 text-xs px-4 text-center">
                  Not capturing yet — click "Start capture" below, then choose the livestream tab it just opened from the share picker.
                </div>
              )}
              {trackerOverlay}
              {captureAreaOverlay}
            </div>
            {/* Reference livestream — pinned here (inside the sticky,
                non-scrolling header above the action deck) instead of at
                the bottom of the scrollable section below, which used to
                mean scrolling down to check calibration/OCR readings
                scrolled the one thing worth comparing them against clean
                out of view. Collapsed by default to keep the pane compact
                — the capture canvas above is what actually gets read. */}
            {embedUrl && (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setReferenceStreamOpen((v) => !v)}
                  className="text-[10px] text-white/40 hover:text-white/60 flex items-center gap-1"
                >
                  {referenceStreamOpen ? "▾" : "▸"} Livestream (reference only)
                </button>
                {referenceStreamOpen && (
                  <div className="relative w-full max-w-[220px] aspect-video rounded overflow-hidden select-none border border-white/10">
                    <iframe src={embedUrl} className="w-full h-full" allow="autoplay; encrypted-media" allowFullScreen />
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 lg:p-4 space-y-4">

            {/* Local capture (admin PC) — only drives anything when this match is on local_ocr.
                Moved to directly under the match header (was previously the very last section
                on the page) so the OCR tracker + calibration controls are reachable without
                scrolling past the moment list, draft sim, and scoreboard first — see the
                "Prioritize admin controls" ask. */}
            {match.update_source === "local_ocr" && (
              <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Match capture — one monitor, one feed</h2>
          {match.update_source === "local_ocr" && (
            <button
              onClick={captureActive ? stopCapture : startCapture}
              disabled={!captureActive && !isEditable}
              title={!isEditable && !captureActive ? "Not available while the match is scheduled" : undefined}
              className={`text-xs rounded px-3 py-1.5 disabled:opacity-40 ${
                captureActive ? "bg-red-500/20 text-red-300" : "border border-white/10 hover:bg-white/10"
              }`}
            >
              {captureActive ? "Stop capture" : "Start capture"}
            </button>
          )}
        </div>
        <p className="text-[10px] text-white/40">
          Open the livestream yourself in its own window first (fullscreen it there for the most accurate reads),
          then click "Start capture" — when the share picker appears, choose that window, not a tab and not this
          admin console. Window capture keeps delivering frames no matter what you Alt+Tab to or work on here
          instead — nothing on this side ever touches or refocuses it. Team kills, team net worth, the game
          timer, each player&apos;s K/D/A, objectives, and kill moments (double/triple/maniac/savage, attributed to
          the player named in the kill banner) all live in the tracker overlay drawn on the Match capture canvas
          above.
        </p>

        {match.update_source === "local_ocr" && (
          <p className="text-xs text-white/50 bg-white/5 border border-white/10 rounded px-3 py-2">
            {PHASE_TRACKER_HINTS[match.state] ?? NO_TRACKER_PHASE_HINT}
          </p>
        )}

        {/* OCR-assisted, admin-confirmed: a plausible reading still
            auto-applies exactly as before (that's the automation), but
            anything a guard held back — never-decreases, spike caps,
            spawn-timing/tower-cap plausibility — lands here instead of
            being silently discarded. Always visible (not behind "Show
            details") since it needs a decision, not just a glance. */}
        {Object.values(flaggedReadings).length > 0 && (
          <div className="space-y-1.5 border border-yellow-500/30 bg-yellow-500/5 rounded px-3 py-2">
            <p className="text-xs font-semibold text-yellow-300">
              {Object.values(flaggedReadings).length} reading{Object.values(flaggedReadings).length === 1 ? "" : "s"} need{Object.values(flaggedReadings).length === 1 ? "s" : ""} your confirmation
            </p>
            {Object.values(flaggedReadings)
              .sort((a, b) => b.flaggedAt - a.flaggedAt)
              .map((entry) => (
                <div key={entry.field} className="flex items-start gap-2 text-xs bg-black/20 rounded px-2 py-1.5">
                  <span
                    title={`OCR confidence: ${entry.confidence != null ? `${Math.round(entry.confidence)}%` : "unknown"}`}
                    className={`mt-1 shrink-0 w-2 h-2 rounded-full ${confidenceColor(entry.confidence)}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-white/80">{entry.label}</div>
                    <div className="text-white/40">
                      Raw read: <span className="text-white/60">&quot;{entry.raw}&quot;</span>
                    </div>
                    <div className="text-white/40">{entry.reason}</div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => applyFlaggedReading(entry.field)}
                      className="text-[10px] border border-emerald-500/50 text-emerald-400 rounded px-2 py-1 hover:bg-emerald-500/10 whitespace-nowrap"
                    >
                      ✓ Apply
                    </button>
                    <button
                      onClick={() => dismissFlaggedReading(entry.field)}
                      className="text-[10px] border border-white/20 text-white/60 rounded px-2 py-1 hover:bg-white/10 whitespace-nowrap"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* Nothing else here makes it obvious when a phase has zero
            regions calibrated — OCR just silently reads nothing forever
            in that case, which looked identical to "OCR is broken" from
            the outside. Doubles as the calibration-details toggle — once
            everything's calibrated there's rarely a reason to look at the
            tracker table/video overlay again, so it collapses
            automatically (see the effect by allTrackersCalibrated above)
            and this becomes the way back in. */}
        {match.update_source === "local_ocr" && activeTrackers.length > 0 && (
          <button
            onClick={() => setOcrDetailsOpen((v) => !v)}
            className={`w-full text-left text-xs rounded px-3 py-2 border flex items-center justify-between gap-2 ${
              allTrackersCalibrated
                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                : "text-yellow-300 border-yellow-500/30 bg-yellow-500/10"
            }`}
          >
            <span>
              {activeTrackers.filter((t) => regions[t.field]).length}/{activeTrackers.length} trackers calibrated for this phase
              {!allTrackersCalibrated && " — uncalibrated trackers read nothing, however OCR-ready the rest looks"}
            </span>
            <span className="shrink-0 text-white/40">{ocrDetailsOpen ? "▾ Hide details" : "▸ Show details"}</span>
          </button>
        )}

        {/* Distinct from the calibration warning above: every field IS
            calibrated, capture IS running, but nothing has actually read
            successfully in 15+ seconds. That combination almost always
            means the calibrated regions don't line up with what's
            currently on screen — most commonly because the captured
            window/tab this session is showing something different than
            whatever the regions were originally drawn against (a
            different resolution, a different broadcast layout, or the
            picked source isn't actually the livestream). Recalibrating
            below (drag each region onto where the number actually sits
            right now) is the fix. */}
        {allTrackersUnhealthy && (
          <div className="lv-alert-warning text-xs px-3 py-2 space-y-1">
            <p className="font-semibold">No OCR reads for any field in 15+ seconds, despite every region being calibrated.</p>
            <p className="text-white/70">
              The calibrated regions almost certainly don&apos;t line up with what&apos;s on screen in the source you just
              picked — a different resolution/layout than whatever they were drawn against, or the captured window
              isn&apos;t showing the broadcast right now. Open &quot;Show details&quot; above and drag each region back onto
              where its number actually sits, or run Auto-place if this is a fresh calibration.
            </p>
          </div>
        )}

        {match.update_source === "local_ocr" && match.team_a && match.team_b && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-white/50">Which team is on the left of the broadcast overlay?</label>
            <select
              value={resolveLeftTeamId() ?? ""}
              onChange={(e) => setOcrLeftTeam(e.target.value)}
              className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
            >
              <option value={match.team_a.id}>{match.team_a.name}</option>
              <option value={match.team_b.id}>{match.team_b.name}</option>
            </select>
            <span className="text-[10px] text-white/30">
              Set this once per game if sides swap — the "left"/"right" regions below resolve to whichever team this says, no recalibration needed.
            </span>
          </div>
        )}

        {match.update_source !== "local_ocr" ? (
          <p className="text-xs text-white/40">
            This is a Normal match (Liquipedia auto). Click &quot;Normal match&quot; above to make it a Hot match
            and take over with this PC&apos;s screen capture.
          </p>
        ) : !ocrDetailsOpen ? null : (
          <>
            {/* Two independent capture pipelines, either one drives the
                same downstream writes (never-decreases guards, phase
                scoping, flagged-reading review) — Manual is the original,
                deterministic per-region Tesseract read; AI sends the whole
                cropped frame to a vision model instead, so there's no
                tracker calibration to draw or maintain at all. Switching
                is locked out mid-capture (stop first) since the two modes
                run on different intervals and read from different state. */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/40">Capture pipeline:</span>
              <div className="inline-flex rounded border border-white/10 overflow-hidden">
                <button
                  onClick={() => setCaptureMode("manual")}
                  disabled={captureActive}
                  className={`text-[10px] px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                    captureMode === "manual" ? "bg-signal text-ink font-semibold" : "text-white/60 hover:bg-white/10"
                  }`}
                >
                  Manual region OCR
                </button>
                <button
                  onClick={() => setCaptureMode("ai")}
                  disabled={captureActive}
                  className={`text-[10px] px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                    captureMode === "ai" ? "bg-signal text-ink font-semibold" : "text-white/60 hover:bg-white/10"
                  }`}
                  title="Sends the whole cropped livestream frame to a vision model every 60s instead of reading hand-calibrated regions — no trackers to draw, but needs GROQ_API_KEY configured and costs a model call per tick"
                >
                  AI full-frame (beta)
                </button>
              </div>
              {captureActive && <span className="text-[10px] text-white/30">Stop capture to switch</span>}
            </div>
            <p className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded px-2 py-1.5">
              {captureMode === "manual"
                ? "Manual region OCR — deterministic, runs entirely in your browser, no AI involved. Needs each field's region calibrated below before it reads anything."
                : "AI full-frame — a vision model reads the whole livestream frame directly (game timer, objectives, K/D/A, kill banners), no region calibration needed. Beta: less predictable than manual OCR, and each read costs a model call. Same never-decreases safety guards apply either way."}
            </p>

            {captureMode === "ai" && (
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  value={overlayHint}
                  onChange={(e) => setOverlayHint(e.target.value)}
                  onBlur={saveOverlayHint}
                  placeholder="Overlay hint (optional) — e.g. &quot;kill banners appear top-center in yellow text&quot;"
                  className="flex-1 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                />
                <button
                  onClick={saveOverlayHintAsTournamentDefault}
                  disabled={!overlayHint}
                  className="text-[10px] border border-white/10 rounded px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
                  title="New matches in this tournament will start with this hint already filled in"
                >
                  {overlayHintSavedAsDefault ? "Saved ✓" : "Save as tournament default"}
                </button>
              </div>
            )}

            {/* Tracker placement/editing only ever makes sense while the game
                is actually ongoing — the broadcast HUD trackers are calibrated
                against isn't even on screen during a Technical Pause (usually
                a "please stand by" card or nothing at all), so there's nothing
                real to place or adjust here. Capture itself can still be left
                running (harmless — activeTrackers filters by match.state, so
                a Technical Pause tick reads nothing anyway), just no UI to
                place/edit trackers while paused. */}
            {captureActive && match.state === "TECHNICAL_PAUSE" && (
              <p className="text-xs text-white/40 border border-white/10 rounded p-3">
                Tracker placement is hidden during Technical Pause — switch the match back to "Match Ongoing" to place or adjust trackers.
              </p>
            )}
            {captureActive && match.state !== "TECHNICAL_PAUSE" && (
              <div className="space-y-3">
                {/* Single sticky toolbar — every placement action (edit
                    mode, phase filter, captured area, templates, auto-
                    place, AI layout, countdown override) pinned together
                    at the top of this scrolling section, instead of the
                    edit-mode/phase-filter/captured-area row being sticky
                    while auto-place/templates/countdown sat in a second,
                    non-sticky row below it that could still scroll out of
                    reach. Templates and Captured area — each previously a
                    whole row of their own — are now single buttons that
                    open a small panel (InlineMenuPopover) with the same
                    controls inside, which is what makes everything else
                    fit in one compact row instead of wrapping across
                    several. */}
                <div className="sticky top-0 z-10 -mx-3 lg:-mx-4 px-3 lg:px-4 py-2 bg-ink/95 backdrop-blur border-b border-white/10">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Explicit toggle instead of guessing "tap to play" vs.
                      "drag to place a tracker" from the gesture itself.
                      Deliberately loud (filled background when on) since
                      it silently changes what a click on the video does —
                      full explanation lives in the title tooltip now that
                      this toolbar has more in it than room for a standing
                      sentence of body text. */}
                  <button
                    type="button"
                    onClick={() => setTrackerEditMode((v) => !v)}
                    aria-pressed={trackerEditMode}
                    className={`text-xs rounded px-3 py-1.5 border whitespace-nowrap ${
                      trackerEditMode ? "bg-signal text-ink border-signal font-semibold" : "border-white/20 text-white/70 hover:bg-white/10"
                    }`}
                    title={
                      trackerEditMode
                        ? "Tracker edit mode is ON — drag directly on the Match capture canvas above to place a new tracker, or click an existing outlined region to move/resize it."
                        : "Tracker edit mode is OFF — turn this on to place or adjust tracker boxes on the Match capture canvas above. When off, clicks pass through to the video instead."
                    }
                  >
                    {trackerEditMode ? "✏️ Edit mode: ON" : "Edit mode: OFF"}
                  </button>
                  <InlineMenuSelect
                    value={canvasPhaseFilter}
                    onChange={setCanvasPhaseFilter}
                    title="Only regions for this phase are shown on the canvas — auto-follows the match's live phase"
                    options={[
                      { value: "", label: "All phases" },
                      ...TRACKER_PHASES.map((p) => ({ value: p, label: p.replace(/_/g, " ") })),
                    ]}
                  />
                  {/* Captured area — an optional hard boundary trackers get
                      clamped inside on save and screenshots get cropped to
                      (see clampBoxToArea/cropVideoToEmbed). forceOpen while
                      captureAreaEditMode is on keeps Lock/Cancel reachable
                      for the whole drag, which happens on the canvas above,
                      outside this popover's own DOM. */}
                  <InlineMenuPopover
                    label="Captured area"
                    icon="🖼"
                    forceOpen={captureAreaEditMode}
                    accentClassName={
                      captureArea
                        ? "border-yellow-400/50 text-yellow-300 hover:bg-yellow-400/10"
                        : "border-white/20 text-white/70 hover:bg-white/10"
                    }
                  >
                    <p className="text-[10px] text-white/50">
                      {captureAreaEditMode
                        ? "Drag on the canvas above to draw/adjust the captured area, then Lock it in."
                        : captureArea
                        ? "Set — every tracker save and screenshot is kept inside it (yellow outline on the canvas above)."
                        : "Not set — trackers and screenshots use the whole captured frame."}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {!captureAreaEditMode ? (
                        <button
                          type="button"
                          onClick={startEditingCaptureArea}
                          className="text-xs rounded px-3 py-1.5 border border-yellow-400/40 text-yellow-300 hover:bg-yellow-400/10 whitespace-nowrap"
                        >
                          {captureArea ? "Adjust" : "Set captured area"}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={lockCaptureArea}
                            disabled={!captureAreaDraft}
                            className="text-xs rounded px-3 py-1.5 bg-yellow-400 text-ink font-semibold disabled:opacity-40 whitespace-nowrap"
                          >
                            Lock captured area
                          </button>
                          <button
                            type="button"
                            onClick={cancelCaptureAreaEdit}
                            className="text-xs rounded px-3 py-1.5 border border-white/20 text-white/70 hover:bg-white/10 whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {captureArea && !captureAreaEditMode && (
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm("Clear the captured area? Trackers/screenshots go back to using the whole captured frame.")) clearCaptureArea();
                          }}
                          className="text-xs rounded px-3 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10 whitespace-nowrap"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </InlineMenuPopover>
                  {captureMode === "manual" && (
                    <>
                      {/* Saved templates — Apply/Edit/Delete an existing one,
                          or save the current layout as a new one, all inside
                          one panel instead of the dropdown+3 buttons+name-
                          input+save-button that used to be their own whole
                          toolbar row. */}
                      <InlineMenuPopover label="Templates" icon="🗂">
                        {templatesLoaded && trackerTemplates.length > 0 && (
                          <div className="space-y-1.5 pb-2 border-b border-white/10">
                            <InlineMenuSelect
                              value={selectedTrackerTemplate}
                              onChange={setSelectedTrackerTemplate}
                              placeholder="Apply a saved template..."
                              className="w-full"
                              options={[
                                { value: "", label: "Apply a saved template..." },
                                ...trackerTemplates.map((t) => ({ value: t.name, label: `${t.name} (${t.regionCount})` })),
                              ]}
                            />
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                onClick={() => applyTrackerTemplate(selectedTrackerTemplate)}
                                disabled={!selectedTrackerTemplate || applyingTemplate}
                                className="text-xs border border-white/20 text-white/70 rounded px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
                                title="Fills in whatever this template has for any field not already tracked — never touches ones that already are"
                              >
                                {applyingTemplate ? "Applying…" : "Apply"}
                              </button>
                              <button
                                onClick={() => renameTrackerTemplate(selectedTrackerTemplate)}
                                disabled={!selectedTrackerTemplate || renamingTemplate}
                                title="Rename this template"
                                className="text-xs border border-white/20 text-white/70 rounded px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => deleteTrackerTemplate(selectedTrackerTemplate)}
                                disabled={!selectedTrackerTemplate || deletingTemplate}
                                title="Delete this template — matches already using it keep their trackers, this only removes it from the list"
                                className="text-xs border border-red-500/40 text-red-300 rounded px-2 py-1.5 hover:bg-red-500/10 disabled:opacity-40 whitespace-nowrap"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <input
                            value={newTemplateName}
                            onChange={(e) => setNewTemplateName(e.target.value)}
                            placeholder="Save current layout as..."
                            className="flex-1 min-w-0 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                          />
                          <button
                            onClick={() => saveTrackersAsTemplate(newTemplateName)}
                            disabled={!newTemplateName.trim() || savingTemplateAs}
                            className="text-xs border border-white/20 text-white/70 rounded px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 whitespace-nowrap"
                            title="Saves every currently-calibrated region under this name, reusable on any future match"
                          >
                            {savingTemplateAs ? "Saving…" : "Save"}
                          </button>
                        </div>
                      </InlineMenuPopover>
                      <button
                        onClick={autoPlaceDefaultTrackers}
                        disabled={autoPlacingTrackers}
                        className="text-xs border border-signal/40 text-signal rounded px-3 py-1.5 hover:bg-signal/10 disabled:opacity-40 whitespace-nowrap"
                        title="Fills in the standard MLBB broadcast layout (net worth, timer, objectives, K/D/A, kill banner) for any GAME_STARTED field that isn't tracked yet — never touches ones that already are"
                      >
                        {autoPlacingTrackers ? "Placing…" : "⊞ Auto-place"}
                      </button>
                      <button
                        onClick={suggestLayoutFromScreenshot}
                        disabled={aiLayoutSuggesting || !captureActive}
                        className="text-xs border border-purple-400/40 text-purple-300 rounded px-3 py-1.5 hover:bg-purple-400/10 disabled:opacity-40 whitespace-nowrap"
                        title="Takes one screenshot of the current capture and asks a vision model to locate the standard HUD elements, then places trackers on whatever it finds — for any field not already tracked. Needs GROQ_API_KEY configured."
                      >
                        {aiLayoutSuggesting ? "Analyzing…" : "📸 AI layout"}
                      </button>
                      {activeTrackers.some((t) => t.category === "countdown") && (
                        <div className="flex items-center gap-1">
                          <input
                            value={manualTimeInputs.countdown ?? ""}
                            onChange={(e) => setManualTimeInputs((prev) => ({ ...prev, countdown: e.target.value }))}
                            placeholder="MM:SS"
                            className="w-16 bg-white/10 border border-white/10 rounded px-1.5 py-1.5 text-xs"
                          />
                          <button
                            onClick={() => setManualCountdown(manualTimeInputs.countdown ?? "")}
                            title="Set the countdown clock directly instead of waiting on OCR"
                            className="text-xs border border-white/20 text-white/70 rounded px-2 py-1.5 hover:bg-white/10 whitespace-nowrap"
                          >
                            Set countdown
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {aiLayoutStatus && <p className="text-[10px] text-white/50 pt-1.5">{aiLayoutStatus}</p>}
                </div>
                {/* The drag-to-calibrate canvas itself now lives up in the
                    Livestream pane, overlaid directly on the embed iframe
                    (see data-crop-container there) — this is what makes
                    region percentages mean "percent of the livestream"
                    instead of "percent of the whole captured tab". This
                    section keeps just the toolbar above and the tracker
                    list/management tools below. */}

                {/* Only shown pre-draw (nothing to float a positioned panel
                    next to yet) — once draftBox exists, the floating
                    label + Lock/Cancel on the canvas itself (see
                    regionOverlayPos above) takes over and this is hidden,
                    so there's exactly one set of Save/Cancel controls
                    visible at a time, not two. */}
                {captureMode === "manual" && calibratingField && !draftBox && (
                  <div className="flex gap-2">
                    <span className="text-xs text-white/50 self-center">{trackers.find((t) => t.field === calibratingField)?.label}</span>
                    <button onClick={cancelDraftBox} className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10">
                      Cancel
                    </button>
                  </div>
                )}

                {captureMode === "ai" && (
                  <div className="border border-white/10 rounded p-3 space-y-1 text-xs">
                    {aiStatus && <p className="text-red-400">{aiStatus}</p>}
                    {aiDetection ? (
                      <>
                        <p>
                          Phase: <strong>{aiDetection.phase}</strong>
                          {aiDetection.game_timer_mm_ss && <> · Timer: <strong>{aiDetection.game_timer_mm_ss}</strong></>}
                          {typeof aiDetection.confidence === "number" && (
                            <span className="text-white/40"> · confidence {Math.round(aiDetection.confidence * 100)}%</span>
                          )}
                        </p>
                        {aiDetection.draft_actions?.length > 0 && (
                          <p className="text-white/60">
                            Draft: {aiDetection.draft_actions.map((a) => `${a.type} ${a.hero_name} (${a.team_name})`).join(", ")}
                          </p>
                        )}
                        {aiDetection.player_stats?.length > 0 && (
                          <p className="text-white/60">
                            Stats read for: {aiDetection.player_stats.map((s) => s.player_name).join(", ")}
                          </p>
                        )}
                        {aiDetection.key_moment_banner !== "NONE" && (
                          <p className="text-yellow-300">
                            Key moment: {aiDetection.key_moment_banner}
                            {aiDetection.key_moment_player_name ? ` — ${aiDetection.key_moment_player_name}` : ""}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-white/40">Waiting for first frame…</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {suggestedWinner && match.team_a && match.team_b && (
              <div className="lv-alert-warning flex flex-wrap items-center gap-3 text-sm px-4 py-3">
                <span className="text-sm">
                  AI detected a possible winner:{" "}
                  <strong>{suggestedWinner === match.team_a.id ? match.team_a.name : match.team_b.name}</strong>
                </span>
                <button
                  onClick={() => {
                    declareGameWinner(suggestedWinner);
                    setSuggestedWinner(null);
                  }}
                  className="lv-btn-primary"
                >
                  Confirm & finish game
                </button>
                <button onClick={() => setSuggestedWinner(null)} className="lv-btn-ghost">
                  Dismiss
                </button>
              </div>
            )}

            {/* Kill-streak detection (Double/Triple Kill, Maniac, Savage) —
                a true pop-out (fixed, centered, dimmed backdrop) rather
                than an inline banner, so it's impossible to miss no
                matter where the admin has scrolled to on a long page.
                Cancel suppresses this same moment type from re-triggering
                for a while — the banner it was read from stays on screen
                for several seconds, long enough to get picked up again on
                the very next OCR tick and pop right back up otherwise. */}
            {suggestion && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
                <div className="lv-alert-warning flex flex-col gap-3 text-sm px-5 py-4 max-w-sm w-full shadow-xl">
                  <span className="text-base">
                    Detected: <strong className="uppercase">{suggestion.type.replace("_", " ")}</strong>{" "}
                    <span className="text-white/40 block text-xs mt-1">&quot;{suggestion.raw}&quot;</span>
                  </span>
                  {/* Player attribution from OCR/AI-vision text-matching is a
                      best-effort guess — left editable here so a failed match
                      (or a wrong one) doesn't block logging the moment. */}
                  <select
                    value={suggestion.playerId ?? ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      setSuggestion((prev) => (prev ? { ...prev, playerId: id, playerName: players.find((p) => p.id === id)?.ign ?? null } : prev));
                    }}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                  >
                    <option value="">No player</option>
                    {[...(match.team_a ? players.filter((p) => p.team_id === match.team_a!.id) : []), ...(match.team_b ? players.filter((p) => p.team_id === match.team_b!.id) : [])].map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.ign}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        dismissedSuggestionUntilRef.current[suggestion.type] = Date.now() + 15_000;
                        setSuggestion(null);
                      }}
                      className="lv-btn-ghost"
                    >
                      Cancel
                    </button>
                    <button onClick={confirmSuggestion} className="lv-btn-primary">
                      Log this
                    </button>
                  </div>
                </div>
              </div>
            )}

            {consistencyWarning && (
              <div className="flex flex-wrap items-center gap-3 bg-orange-500/10 border border-orange-500/30 rounded px-4 py-2">
                <span className="text-xs text-orange-300">⚠ {consistencyWarning}</span>
                <button onClick={() => setConsistencyWarning(null)} className="lv-btn-ghost !text-xs !py-1">
                  Dismiss
                </button>
              </div>
            )}
          </>
        )}
      </section>
            )}

          </div>
        </div>

        {/* ACTION DECK — the one scrollable column. Yellow (game data) and
            Red (moment timeline) merge into this single pane; phase-
            relevant content is prioritized further down instead of
            splitting into more side-by-side columns. Own rounded border,
            same reasoning as the monitor pane above — no shared row to
            stretch either one to match the other's height. */}
        <div
          className="flex flex-col rounded-lg border border-white/10 w-full max-w-full"
          style={{ width: "100%" }}
        >
          <div className="space-y-6 p-3 lg:p-4">
            {/* Paused-state banner — the console already halts capture and
                locks Scoreboard/Objectives edits during TECHNICAL_PAUSE
                (see captureActive/SCOREBOARD_EDITABLE_PHASES above); this
                just makes that state impossible to miss at a glance, per
                the blueprint's "clearly indicate paused state" ask. */}
            {match.state === "TECHNICAL_PAUSE" && (
              <div
                className="rounded px-3 py-2 text-xs font-semibold text-amber-200 border-2 border-amber-400/60"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, rgba(251,191,36,0.12), rgba(251,191,36,0.12) 10px, rgba(251,191,36,0.04) 10px, rgba(251,191,36,0.04) 20px)",
                }}
              >
                ⏸ Technical pause — clock frozen, capture halted. Resume with the phase stepper above once play restarts.
              </div>
            )}

            {/* Public clock source — moved above the Moment Timeline so it's
                the first thing an admin sees in this column; everything
                below fits without its own scroll, only the Moment Timeline
                (right below) scrolls internally. */}
            {match.update_source === "local_ocr" && (
              <div className="space-y-2">
                <p className="text-xs text-white/50">
                  Current minute mark (used for every log action below): <span className="font-bold text-white text-sm tabular-nums">{minute}&apos;</span>
                  {" "}— follows whichever clock source is selected, no manual entry needed.
                </p>
                <label className="text-xs text-white/50 block pt-2">Public clock source</label>
                <div className="flex gap-1">
                  {(["ocr", "manual"] as const).map((src) => (
                    <button
                      key={src}
                      onClick={() => setClockSource(src)}
                      className={`text-[10px] px-2 py-1 rounded border ${
                        game.clock_source === src ? "border-signal text-signal" : "border-white/10 text-white/50"
                      }`}
                    >
                      {src === "ocr" ? "OCR clock" : "Manual stopwatch"}
                    </button>
                  ))}
                </div>
                {/* Only one of these two blocks at a time — previously both
                    rendered together regardless of which source was selected,
                    so pressing "Start" here always ran the manual stopwatch
                    even with "OCR clock" selected above, which read as "OCR
                    shows manual seconds instead of the real time." */}
                {game.clock_source === "manual" ? (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-lg font-bold tabular-nums w-16">
                      {String(Math.floor(manualElapsedSeconds(game) / 60)).padStart(2, "0")}:
                      {String(manualElapsedSeconds(game) % 60).padStart(2, "0")}
                    </span>
                    {game.manual_time_running ? (
                      <button onClick={pauseManualClock} className="text-xs border border-white/10 rounded px-2 py-1.5 hover:bg-white/10">
                        ⏸ Pause
                      </button>
                    ) : (
                      <button onClick={startManualClock} className="text-xs border border-white/10 rounded px-2 py-1.5 hover:bg-white/10">
                        ▶ Start
                      </button>
                    )}
                    <button onClick={() => adjustManualClock(-60)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                      −1m
                    </button>
                    <button onClick={() => adjustManualClock(60)} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                      +1m
                    </button>
                    <input
                      type="text"
                      placeholder="MM:SS"
                      title="Set the clock directly, e.g. 12:30"
                      className="w-16 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs"
                      onBlur={(e) => {
                        if (e.target.value === "") return;
                        const m = e.target.value.trim().match(/^(\d{1,3}):(\d{2})$/);
                        if (m) setManualClockSeconds(Number(m[1]) * 60 + Number(m[2]));
                        e.target.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-lg font-bold tabular-nums w-16">
                      {game.current_time_seconds != null
                        ? `${String(Math.floor(game.current_time_seconds / 60)).padStart(2, "0")}:${String(game.current_time_seconds % 60).padStart(2, "0")}`
                        : "—:—"}
                    </span>
                    <span className="text-[10px] text-white/40">
                      {readings.game_timer
                        ? `Last OCR read: "${readings.game_timer}"`
                        : "No OCR read yet — calibrate the Game timer region below and start capture."}
                    </span>
                  </div>
                )}
                <p className="text-[10px] text-white/40">
                  {game.clock_source === "manual"
                    ? "Manual stopwatch — a fallback for when OCR can't read the on-screen timer."
                    : "OCR clock — reads the Game timer region below every tick while capture is running."}
                  {" "}Whichever source is selected above is what the public page shows.
                </p>
              </div>
            )}

            {/* Moment Timeline — moved to the very top of the action deck
                (was at the bottom, "where an operator's eye lands after
                every other control" — but that meant it was the thing
                most often scrolled past, not seen). Full keyMoments list
                now, not sliced to 5 — the public match page shows every
                logged moment for the game and this should match it
                exactly; a truncated admin-side list was actually showing
                *less* than what viewers see, including losing early
                pick/ban entries off the end once enough later moments
                logged. The max-h/overflow-y-auto below is what keeps this
                compact (~5 rows visible) — scrolling reveals the rest,
                nothing is discarded. */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold">Moment Timeline</h2>
                  {/* Same live in-game clock the public match page shows
                      beside its own Moment Timeline heading — easy to spot
                      here too, not just in the header row above. */}
                  {(match.state === "GAME_STARTED" || match.state === "TECHNICAL_PAUSE") && (
                    <span className="text-base font-bold text-signal tabular-nums" title="Live in-game clock">
                      ⏱ {mmssTimestamp()}
                    </span>
                  )}
                </div>
                {lastAction && (
                  <button
                    onClick={undoLastAction}
                    title="Ctrl+Z also does this — undoes only the single most recent logged action"
                    className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10 text-white/60 hover:text-white"
                  >
                    ⎌ Undo: {lastAction.label} (Ctrl+Z)
                  </button>
                )}
              </div>
              <div ref={adminMomentListRef} className="flex flex-col gap-1.5 text-xs max-h-[260px] overflow-y-auto pr-1">
                {/* Ascending by minute_mark (query order) — newest moment at
                    the bottom, matching the public match page instead of a
                    reversed admin-only order. */}
                {keyMoments.map((km) => {
                  const player = players.find((p) => p.id === km.player_id);
                  const label = km.description ?? `${km.type.replace(/_/g, " ")}${player ? ` — ${player.ign}` : ""}`;
                  // Pick/ban moments carry the hero name only inside the
                  // formatted description text (no separate column on
                  // key_moments) — logPickBanMoment always writes it as
                  // "<team> picks|bans <hero>[ — <player>]", so this parses
                  // it back out to look up the icon. Falls back to no icon
                  // if the text doesn't match (a manually-edited entry).
                  const heroName =
                    (km.type === "pick" || km.type === "ban") && km.description
                      ? km.description.split(" — ")[0].match(/ (?:picks|bans) (.+)$/)?.[1] ?? null
                      : null;
                  const heroIconUrl = heroName ? heroIconFor(heroName) : null;
                  // Same colored pick/ban verb the public match page's own
                  // Moment Timeline renders — see its renderMomentLabel.
                  const verbMatch =
                    (km.type === "pick" || km.type === "ban") && km.description
                      ? km.description.match(/^(.+?) (picks|bans) (.+?)(?: — .+)?$/)
                      : null;
                  const labelNode = verbMatch ? (
                    <>
                      {verbMatch[1]} <span className={verbMatch[2] === "picks" ? "text-emerald-500 font-bold" : "text-signal font-bold"}>{verbMatch[2]}</span>{" "}
                      {label.slice(verbMatch[1].length + verbMatch[2].length + 2)}
                    </>
                  ) : (
                    label
                  );
                  if (editingMomentId === km.id) {
                    return (
                      <div key={km.id} className="px-3 py-2 rounded bg-signal/20 flex items-center gap-1.5">
                        <input
                          value={editingMomentText}
                          onChange={(e) => setEditingMomentText(e.target.value)}
                          className="bg-white/10 border border-white/10 rounded px-1.5 py-0.5 text-xs w-48"
                          autoFocus
                        />
                        <button onClick={() => updateKeyMoment(km.id, editingMomentText)} className="text-white/60 hover:text-emerald-400 normal-case">✓</button>
                        <button onClick={() => setEditingMomentId(null)} className="text-white/30 hover:text-red-400 normal-case">✕</button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={km.id}
                      className={`px-3 py-2 rounded flex items-center gap-1.5 ${
                        km.is_key_moment ? "bg-signal/30 border border-signal/50 font-semibold" : "bg-white/10"
                      }`}
                    >
                      {heroIconUrl && <HeroIcon url={heroIconUrl} name={heroName} size="xs" className="shrink-0" />}
                      <span className="flex-1 min-w-0 truncate">
                        {km.is_key_moment && "⭐ "}
                        {km.minute_mark}&apos; {labelNode}
                        {km.screenshot_url && " 📸"}
                      </span>
                      <button
                        onClick={() => {
                          setEditingMomentId(km.id);
                          setEditingMomentText(label);
                        }}
                        className="text-white/30 hover:text-white/70 normal-case shrink-0"
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() =>
                          postToTelegram(
                            `🔥 <b>${label}</b>\n${match.team_a?.name} vs ${match.team_b?.name}\n${match.tournament?.name}`,
                            { entityType: "key_moment", entityId: km.id, notificationType: "key_moment" },
                            km.screenshot_url ?? undefined
                          )
                        }
                        className="text-white/30 hover:text-signal normal-case shrink-0"
                        title="Post to Telegram"
                      >
                        📢
                      </button>
                      <button onClick={() => deleteKeyMoment(km.id)} className="text-white/30 hover:text-red-400 normal-case shrink-0">✕</button>
                    </div>
                  );
                })}
                {keyMoments.length === 0 && <span className="text-white/30 text-xs">No moments logged yet.</span>}
              </div>
            </section>

            {/* Declare Game Winner now lives at the top of the monitor
                pane (left column), above the livestream — see there.
                Everything else a live game needs constantly — log an
                objective, log a moment — still sits at the very top of this
                column, ahead of the draft board and the rest of the
                game-data sections below. Objectives' +/- counters and the
                moment-template logger are Hot (local_ocr) match features; a
                Normal match's objectives/moments come from the Liquipedia
                sync instead, so it only gets the read-only objectives
                list. */}
            {!DRAFT_PHASES.includes(match.state) && (
              <>
                {/* Objectives — tap-to-log counter per type (click to
                    increment, right-click to undo one), plus a direct
                    number input for when the count has actually drifted
                    from what's really on screen (a missed OCR tick, a
                    string of misclicks) — one-at-a-time undo is too slow
                    for that case.

                    Layout: two columns. Left stacks Objectives, Log a
                    moment, and Game screenshots at the same width, in that
                    order. Right stacks Net worth above Live scoreboard —
                    the score everyone actually watches sits right under
                    the gold lead that explains it, instead of the two
                    being split across separate rows further down the
                    page. */}
                {match.update_source === "local_ocr" ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                    <div className="space-y-4">
                    <section className="space-y-2 bg-white/5 rounded p-3 border border-white/10">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-sm">Objectives</h3>
                        <button
                          onClick={() =>
                            postToTelegram(buildObjectivesMessage(), { entityType: "match", entityId: match.id, notificationType: "objectives_share" })
                          }
                          className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                        >
                          📢 Share
                        </button>
                      </div>
                      <div className="space-y-2">
                        {[match.team_a, match.team_b].map((team, idx) =>
                          team ? (
                            <div key={team.id} className="space-y-1">
                              <p className="text-xs text-white/50">{team.name}</p>
                              <div className="flex flex-wrap gap-1.5">
                                {OBJECTIVE_TYPES.map((type) => (
                                  <span key={type} className="inline-flex items-center gap-1">
                                    <button
                                      onClick={() => incrementObjective(team.id, type)}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        decrementObjective(team.id, type);
                                      }}
                                      disabled={!objectivesEditable}
                                      title={`${team.name} takes a ${type} — right-click to undo. ${OBJECTIVE_RULE_HINTS[type]} (This button always applies — those limits are what OCR auto-reads are held to, not you.)`}
                                      className="text-xs border border-white/10 rounded px-2 py-1 hover:border-signal/50 hover:bg-signal/10 disabled:opacity-40 flex items-center gap-1"
                                    >
                                      <span>{OBJECTIVE_ICONS[type]}</span>
                                      <span className="capitalize">{type}</span>
                                      <span className="font-bold tabular-nums">{objectiveCount(team.id, type)}</span>
                                    </button>
                                    <input
                                      type="number"
                                      min={0}
                                      disabled={!objectivesEditable}
                                      placeholder={String(objectiveCount(team.id, type))}
                                      title={`Set ${team.name}'s ${type} count directly`}
                                      onBlur={(e) => {
                                        if (e.target.value === "") return;
                                        const n = Math.max(0, Math.trunc(Number(e.target.value)));
                                        if (Number.isNaN(n)) return;
                                        setObjectiveCount(team.id, type, n);
                                        e.target.value = "";
                                      }}
                                      className="w-9 bg-white/10 border border-white/10 rounded px-1 py-1 text-[10px] disabled:opacity-40 placeholder:text-white/30"
                                    />
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <span key={idx} />
                          )
                        )}
                      </div>
                    </section>

                    {/* Log a moment — same column, same width as
                        Objectives, directly below it. */}
                    <section className="space-y-2 bg-white/5 rounded p-3 border border-white/10">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-sm">Log a moment</h3>
                        <a href="/admin/moment-templates" className="text-[10px] text-white/40 hover:text-signal">Manage templates ↗</a>
                      </div>
                      <div className="flex gap-2 items-end flex-wrap">
                        <select
                          value={kmTemplateId}
                          onChange={(e) => setKmTemplateId(e.target.value)}
                          className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm min-w-[220px]"
                        >
                          <option value="">Choose a template...</option>
                          <option value={CUSTOM_TEMPLATE_ID}>✎ Custom...</option>
                          {availableTemplates.map((t) => (
                            <option key={t.id} value={t.id}>{t.label_template}</option>
                          ))}
                        </select>
                        {selectedTemplate?.label_template.includes("{team}") && (
                          <select value={kmTeam} onChange={(e) => setKmTeam(e.target.value)} className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm">
                            <option value="">Team</option>
                            {match.team_a && <option value={match.team_a.id}>{match.team_a.name}</option>}
                            {match.team_b && <option value={match.team_b.id}>{match.team_b.name}</option>}
                          </select>
                        )}
                        {selectedTemplate?.label_template.includes("{hero}") && (
                          <select value={kmHero} onChange={(e) => setKmHero(e.target.value)} className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm">
                            <option value="">Hero</option>
                            {heroes.map((h) => (
                              <option key={h.id} value={h.id}>{h.name}</option>
                            ))}
                          </select>
                        )}
                        {selectedTemplate?.label_template.includes("{player}") && (
                          <select value={kmPlayer} onChange={(e) => setKmPlayer(e.target.value)} className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm">
                            <option value="">Player</option>
                            {players.map((p) => (
                              <option key={p.id} value={p.id}>{p.ign}</option>
                            ))}
                          </select>
                        )}
                        {selectedTemplate?.type === "custom" && (
                          <input
                            value={kmCustomText}
                            onChange={(e) => setKmCustomText(e.target.value)}
                            placeholder="Type the custom moment..."
                            className="bg-white/10 border border-white/10 rounded px-3 py-1.5 text-sm min-w-[220px]"
                          />
                        )}
                        <button
                          onClick={logKeyMoment}
                          disabled={!selectedTemplate || !isEditable || (selectedTemplate.type === "custom" && !kmCustomText.trim())}
                          className="lv-btn-ghost disabled:opacity-40"
                        >
                          Log moment
                        </button>
                      </div>
                      {selectedTemplate && (
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 text-[10px] text-white/50">
                            <input
                              type="checkbox"
                              checked={kmAttachScreenshot}
                              onChange={(e) => setKmAttachScreenshot(e.target.checked)}
                              disabled={!captureActive}
                            />
                            📸 Also grab the current frame into this moment
                            {!captureActive && " (start capture above first)"}
                          </label>
                          {selectedTemplate.type === "custom" && (
                            <label className="flex items-center gap-1.5 text-[10px] text-white/50">
                              <input type="checkbox" checked={kmMarkAsKey} onChange={(e) => setKmMarkAsKey(e.target.checked)} />
                              ⭐ Mark as key moment
                            </label>
                          )}
                        </div>
                      )}
                    </section>

                    {/* Game screenshots — same column, same width, directly
                        below Log a moment. */}
                    <section className="space-y-3">
                      <h2 className="font-bold">Game {game.game_number} screenshots</h2>
                      <p className="text-xs text-white/40">
                        Captures the shared-screen frame as-is (items, inventory, scoreboard — whatever&apos;s visible), stamped with the
                        current in-game timer. Shown publicly at the bottom of this game&apos;s page.
                      </p>
                      <div className="flex gap-2 items-center flex-wrap">
                        <button
                          onClick={() => captureScreenshotFromPreview()}
                          disabled={!captureActive || screenshotUploading}
                          className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 disabled:opacity-40"
                          title={captureActive ? "Grab the current shared-screen frame" : "Start capture above first"}
                        >
                          📸 Capture current frame
                        </button>
                        <label className="text-xs border border-white/10 rounded px-3 py-1.5 hover:bg-white/10 cursor-pointer">
                          Upload image...
                          <input type="file" accept="image/*" onChange={handleScreenshotFileSelect} className="hidden" disabled={screenshotUploading} />
                        </label>
                        <input
                          value={screenshotNote}
                          onChange={(e) => setScreenshotNote(e.target.value)}
                          placeholder="Note (optional)"
                          className="bg-white/10 border border-white/10 rounded px-2 py-1.5 text-xs w-40"
                        />
                        {screenshotUploading && <span className="text-xs text-white/40">Uploading...</span>}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {screenshots.map((s) => (
                          <div key={s.id} className="w-40 space-y-1 lv-card-flush p-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={s.image_url} alt="" className="w-full rounded-md border border-white/10" />
                            <div className="flex items-center justify-between text-[10px] text-white/40">
                              <span>{s.in_game_time ?? "—"} · {new Date(s.created_at).toLocaleTimeString()}</span>
                              <button onClick={() => deleteScreenshot(s.id, s.image_url)} className="text-white/30 hover:text-red-400">✕</button>
                            </div>
                            {s.note && <p className="text-[10px] text-white/50">{s.note}</p>}
                          </div>
                        ))}
                        {screenshots.length === 0 && <span className="text-white/30 text-xs">No screenshots for this game yet.</span>}
                      </div>
                    </section>
                    </div>

                    <div className="space-y-4">
                    {/* Net worth — top of the right column, directly above
                        Live scoreboard. */}
                    <section className="space-y-2">
                      <h2 className="font-bold">Net worth</h2>
                      <div className="flex flex-wrap gap-4 items-end">
                        {[
                          { team: match.team_a, key: "team_a_gold" as const, other: latestNetWorth?.team_b_gold ?? 0 },
                          { team: match.team_b, key: "team_b_gold" as const, other: latestNetWorth?.team_a_gold ?? 0 },
                        ].map(({ team, key, other }, idx) =>
                          team ? (
                            <div key={team.id} className="space-y-1">
                              <p className="text-xs text-white/50">{team.name}</p>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  defaultValue={latestNetWorth?.[key] ?? ""}
                                  disabled={!netWorthEditable}
                                  placeholder="Gold"
                                  className="w-28 bg-white/10 border border-white/10 rounded px-2 py-1.5 text-sm disabled:opacity-40"
                                  onBlur={(e) => {
                                    const value = Number(e.target.value);
                                    if (Number.isNaN(value)) return;
                                    if (value === (latestNetWorth?.[key] ?? null)) return;
                                    updateNetWorthManual(idx === 0 ? value : other, idx === 0 ? other : value);
                                  }}
                                />
                                {latestNetWorth?.[key] != null && <span className="text-xs text-white/40 tabular-nums">{formatGold(latestNetWorth[key])}</span>}
                              </div>
                            </div>
                          ) : (
                            <span key={idx} />
                          )
                        )}
                      </div>
                    </section>

                    {/* Live scoreboard. Team kills is strictly the sum of
                        that team's players' kills (see teamKillsValid
                        above) — it must equal the enemy's summed deaths or
                        it isn't shown at all, never a number that doesn't
                        reconcile with the KDA rows below it. */}
                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h2 className="font-bold">Live scoreboard</h2>
                        <div className="flex items-center gap-2">
                          {gameFinished && (
                            <button
                              onClick={() => setEditingFinishedGame((v) => !v)}
                              title="This game is finished — result data (scoreboard, objectives, net worth, hero picks/bans) is read-only until unlocked"
                              className={`text-xs rounded px-2 py-1 border ${
                                editingFinishedGame ? "border-signal/50 text-signal bg-signal/10" : "border-white/10 hover:bg-white/10"
                              }`}
                            >
                              {editingFinishedGame ? "🔓 Unlock" : "🔒 Locked"}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              postToTelegram(buildLiveScoreboardMessage(), {
                                entityType: "match",
                                entityId: match.id,
                                notificationType: "scoreboard_share",
                              })
                            }
                            className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10"
                          >
                            📢 Share
                          </button>
                        </div>
                      </div>
                      {/* Same teamAKillsTotal/teamBKillsTotal the sticky
                          header above and the public match page both use
                          (Math.max of the OCR team-kills override and the
                          summed player kills) — this used to show a
                          different, stricter number (pure player-kill sum,
                          or "Not shown" entirely when it didn't reconcile
                          with enemy deaths), which meant this page could
                          show two different Team Kills counts for the same
                          game at the same time. teamKillsValid still drives
                          a warning note, just not a second, disagreeing
                          number. */}
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white/50">Team kills:</span>
                        <span className="font-bold tabular-nums">
                          {match.team_a?.name} {teamAKillsTotal} – {teamBKillsTotal} {match.team_b?.name}
                        </span>
                        {!teamKillsValid && (
                          <span
                            className="text-amber-300"
                            title="Team A's summed kills should equal Team B's summed deaths (and vice versa) — one of the K/D/A rows below is likely lagging or misread"
                          >
                            ⚠ kills/deaths not fully reconciled yet
                          </span>
                        )}
                      </div>
                      {/* Each player row is ~10 fixed-width fields wide (photo, name,
                          hero picker, K/D/A, action icons) — comfortably fits a desktop
                          window but not a phone screen, and there's no good way to stack
                          a K/D/A entry row without turning every field into its own
                          labeled block. Rather than a wholesale redesign, this scrolls
                          horizontally as one unit (same pattern as the tracker readings
                          table above) — min-w-max on every row keeps columns aligned
                          with the header while scrolling. Zero effect at desktop widths,
                          where the row already fits and overflow-x-auto never engages. */}
                      {[teamAPlayers, teamBPlayers].map((teamPlayers, idx) => (
                        <div key={idx} className="space-y-1 overflow-x-auto">
                          <p className="text-xs text-white/50">{idx === 0 ? match.team_a?.name : match.team_b?.name}</p>
                          <div className="flex gap-2 items-center text-[10px] text-white/40 pl-8 min-w-max">
                            <span className="w-24">Player</span>
                            <span className="w-20">Role</span>
                            <span className="w-24">Hero</span>
                            <span className="w-[122px]">K/D/A</span>
                          </div>
                          {teamPlayers.map((p) => {
                            const stat = statForPlayer(p);
                            const isEditingRoster = editingScoreboardPlayerId === p.id;
                            return (
                              <div key={p.id} className="flex gap-2 items-center text-sm min-w-max">
                                {p.photo_url ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={proxiedImageUrl(p.photo_url)} alt="" className="w-6 h-6 rounded-full object-cover border border-white/10 shrink-0" />
                                ) : (
                                  <span className="w-6 h-6 rounded-full bg-white/10 shrink-0" />
                                )}
                                {isEditingRoster ? (
                                  <input
                                    value={editingScoreboardIgn}
                                    onChange={(e) => setEditingScoreboardIgn(e.target.value)}
                                    className="w-24 bg-white/10 border border-white/10 rounded px-1.5 py-1 text-xs"
                                    autoFocus
                                  />
                                ) : (
                                  <span className="w-24 truncate">{p.ign}</span>
                                )}
                                <span className="w-20 truncate text-white/40 uppercase text-[10px] tracking-wide">{p.role ?? "—"}</span>
                                {(() => {
                                  const pick = effectivePickFor(p.id, idx === 0 ? match.team_a!.id : match.team_b!.id, teamPlayers);
                                  // stat?.hero_name is the authoritative field once set
                                  // (syncDraftHeroesToStats writes it the moment the
                                  // draft's saved, correctPickBanHero keeps it in sync
                                  // after any correction) — falling back to the pick's
                                  // own hero_name here is just a display-side safety net
                                  // for a row whose sync hasn't landed yet, not a second
                                  // source of truth.
                                  const heroName = stat?.hero_name || pick?.hero_name || null;
                                  const iconUrl = heroName ? heroes.find((h) => h.name === heroName)?.icon_url : null;
                                  return (
                                    <>
                                      {iconUrl && <HeroIcon url={iconUrl} name={heroName} size="xs" className="-mr-1" />}
                                      {/* Once this player has a locked-in pick (real or
                                          positionally matched — see effectivePickFor), the
                                          Draft board above is the single place to correct
                                          their hero — that edit already propagates here via
                                          updateStat (see correctPickBanHero/assignHeroToPlayer),
                                          so this dropdown used to be a second, independent way
                                          to set the exact same field: pick a wrong hero here and
                                          it silently disagreed with the Draft board's own record
                                          until the next full reload. Read-only display instead.
                                          Falls back to the dropdown only when there's genuinely
                                          no pick to read from (Normal/Liquipedia matches with no
                                          local draft tracking, or a substitute added straight to
                                          the scoreboard) — that's still the only place to set
                                          it. */}
                                      {pick ? (
                                        <span className="w-24 truncate text-xs" title="Set from the Draft board above — correct it there">
                                          {heroName || "—"}
                                        </span>
                                      ) : null}
                                    </>
                                  );
                                })()}
                                {!effectivePickFor(p.id, idx === 0 ? match.team_a!.id : match.team_b!.id, teamPlayers) && (
                                  <select
                                    value={stat?.hero_name ?? ""}
                                    onChange={(e) => updateStat(p.id, "hero_name", e.target.value)}
                                    disabled={!scoreboardEditable}
                                    className="w-24 bg-white/10 border border-white/10 rounded px-2 py-1 text-xs disabled:opacity-40"
                                  >
                                    <option value="">Hero</option>
                                    {heroes.map((h) => (
                                      <option key={h.id} value={h.name}>{h.name}</option>
                                    ))}
                                  </select>
                                )}
                                {/* K/D/A as one visually-grouped "0/0/0" unit (slash
                                    separators between the three fields) instead of three
                                    unlabeled inputs floating side by side — each stays
                                    independently editable, just read together like the
                                    standard K/D/A notation everywhere else on the site. */}
                                <div className="flex items-center gap-0.5">
                                  {(["kills", "deaths", "assists"] as const).map((field, i) => (
                                    <span key={field} className="flex items-center gap-0.5">
                                      {i > 0 && <span className="text-white/30">/</span>}
                                      <input
                                        type="number"
                                        min={0}
                                        defaultValue={stat?.[field] ?? ""}
                                        placeholder="TBD"
                                        onBlur={(e) => {
                                          if (e.target.value === "") return; // leave TBD, don't coerce a cleared field to 0
                                          const n = Math.max(0, Math.trunc(Number(e.target.value)));
                                          if (Number.isNaN(n)) return;
                                          updateStat(p.id, field, n);
                                        }}
                                        disabled={!scoreboardEditable}
                                        className="w-12 bg-white/10 border border-white/10 rounded px-1.5 py-1 text-xs disabled:opacity-40 placeholder:text-white/30"
                                      />
                                    </span>
                                  ))}
                                </div>
                                <div className="flex gap-1.5 ml-auto">
                                  {isEditingRoster ? (
                                    <>
                                      <button onClick={() => saveScoreboardPlayerEdit(p.id)} className="text-white/50 hover:text-emerald-400 text-xs">✓</button>
                                      <button onClick={() => setEditingScoreboardPlayerId(null)} className="text-white/30 hover:text-red-400 text-xs">✕</button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => {
                                          setEditingScoreboardPlayerId(p.id);
                                          setEditingScoreboardIgn(p.ign);
                                        }}
                                        title="Edit player"
                                        className="text-white/30 hover:text-white/70 text-xs"
                                      >
                                        ✎
                                      </button>
                                      <button
                                        onClick={() => deleteScoreboardPlayer(p.id, p.ign)}
                                        title="Delete player"
                                        className="text-white/30 hover:text-red-400 text-xs"
                                      >
                                        🗑
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          {/* For a substitute the scoreboard didn't already pick up
                              automatically (no hero pick logged for them this game) —
                              adding them here creates their player_stats row, which
                              activeFive() above now also treats as "in the game". Only
                              reachable before the draft locks the roster in, or again
                              once the game's finished (or the match is reset) — the
                              roster set before draft start is the final list while a
                              game is actually in progress. */}
                          {isEditable && ROSTER_ADD_PHASES.has(match.state) && (
                            <div className="flex items-center gap-2 pl-8 pt-1">
                              {(() => {
                                const teamId = idx === 0 ? match.team_a?.id : match.team_b?.id;
                                if (!teamId) return null;
                                const shownIds = new Set(teamPlayers.map((p) => p.id));
                                const available = rosterFor(teamId).filter((p) => !shownIds.has(p.id));
                                if (available.length === 0) return null;
                                return (
                                  <>
                                    <select
                                      value={addPlayerSelect[teamId] ?? ""}
                                      onChange={(e) => setAddPlayerSelect((prev) => ({ ...prev, [teamId]: e.target.value }))}
                                      className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                                    >
                                      <option value="">Add player...</option>
                                      {available.map((p) => (
                                        <option key={p.id} value={p.id}>{p.ign}{p.role ? ` (${p.role})` : ""}</option>
                                      ))}
                                    </select>
                                    <button
                                      onClick={() => {
                                        const playerId = addPlayerSelect[teamId];
                                        if (!playerId) return;
                                        addScoreboardPlayer(playerId);
                                        setAddPlayerSelect((prev) => ({ ...prev, [teamId]: "" }));
                                      }}
                                      disabled={!addPlayerSelect[teamId]}
                                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40"
                                    >
                                      + Add
                                    </button>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      ))}
                    </section>
                    </div>
                  </div>
                ) : (
                  <section className="space-y-2">
                    <h3 className="font-semibold text-sm">Objectives</h3>
                    <div className="bg-white/5 rounded p-2 space-y-1 max-h-40 overflow-y-auto">
                      {objectives.map((obj) => (
                        <div key={obj.id} className="flex items-center justify-between text-xs bg-white/5 rounded px-2 py-1">
                          <span>{obj.type} @ {obj.minute_mark}'</span>
                          <button onClick={() => deleteObjective(obj.id)} className="text-white/30 hover:text-red-400">✕</button>
                        </div>
                      ))}
                      {objectives.length === 0 && <p className="text-xs text-white/40">No objectives logged</p>}
                    </div>
                  </section>
                )}
              </>
            )}

      {/* Draft tool sits first in the center column, directly beside/below
          the tracking canvas — the site owner runs this on a single
          monitor, so having the OCR canvas and the drafting UI stacked
          vertically (true on narrow/stacked layouts; side-by-side at the
          top of the center column on wide ones) instead of competing for
          the same scroll region matters more than the
          "which comes textually first" grouping that used to place this
          next to the game/map selector further down. */}
      {/* Hero picks/bans + roster setup — collapsed by default once the
          game is actually live. It's the primary, always-open surface
          during roster setup and drafting; once GAME_STARTED, correcting a
          hero here already propagates straight into the Live Scoreboard
          below (see updateStat calls in correctPickBanHero/
          assignHeroToPlayer), which is now the read-only display for it —
          so keeping this expanded too just duplicates that same
          information on screen for no reason. Still one click away for the
          rare live correction (open={} only sets the *default*; a manual
          toggle during this phase isn't fought on re-render since the
          prop's value doesn't change again until the phase itself does). */}
      <details className="space-y-3 group" open={DRAFT_PHASES.includes(match.state) || match.state === "MATCH_NOT_STARTED"}>
        {/* Only the title toggles — the action buttons below are a
            sibling, not nested inside <summary>, so clicking "Announce
            draft" etc. doesn't also collapse/expand the section (a button
            click inside <summary> bubbles into summary's own default
            toggle behavior otherwise). */}
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden font-bold flex items-center gap-1.5">
          <span className="text-white/40 text-xs transition-transform group-open:rotate-90">▸</span> Hero picks & bans
        </summary>
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {/* Also rendered near Live scoreboard below for Hot matches —
                duplicated here (same shared editingFinishedGame state) so
                Normal matches, which never render that section at all,
                still have a way to unlock a finished game's picks/bans and
                score for editing. */}
            {gameFinished && (
              <button
                onClick={() => setEditingFinishedGame((v) => !v)}
                title="This game is finished — result data is read-only until unlocked"
                className={`text-xs rounded px-2 py-1 border ${
                  editingFinishedGame ? "border-signal/50 text-signal bg-signal/10" : "border-white/10 hover:bg-white/10"
                }`}
              >
                {editingFinishedGame ? "🔓 Editing finished game — click to lock" : "🔒 Unlock to edit"}
              </button>
            )}
            {/* "Hero reference" (browse-only) and "Announce draft" (a
                manual duplicate of the recap saveDraftAndStartGame already
                posts) are gone — dead weight next to the one button that
                actually matters here. */}
            {match.state === "DRAFT_COMPLETE" && (
              <button
                onClick={saveDraftAndStartGame}
                title="Posts the draft recap to Telegram/Slack and advances the match to Game ongoing"
                className="text-xs border border-signal/50 text-signal rounded px-2 py-1 hover:bg-signal/10 font-semibold"
              >
                💾 SAVE draft &amp; start game
              </button>
            )}
            {/* Correcting picks against Liquipedia's own bracket page only
                makes sense once the actual broadcast has settled the
                result — mid-draft/mid-game there's nothing on Liquipedia
                yet to sync against. */}
            {match.update_source === "local_ocr" && gameFinished && (
              <button
                onClick={syncDraftFromLiquipedia}
                disabled={syncingDraft}
                title="Corrects which hero was picked/banned to match Liquipedia's bracket page. Never touches kill stats or the moment list."
                className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-50"
              >
                {syncingDraft ? "Syncing..." : "🔄 Sync from Liquipedia"}
              </button>
            )}
          </div>
        </div>
        {syncDraftStatus && <p className="text-xs text-white/50">{syncDraftStatus}</p>}

        {/* Draft ban/pick simulation — an optional structured alternative to
            clicking picks/bans onto the board below one at a time: enforces
            the exact fixed order a tournament draft follows and logs each
            step from a searchable hero grid. Moved to the top of this
            section — it's the first thing an admin running a simulated
            draft actually needs, ahead of the board it feeds. DRAFT_STARTED
            only — once the draft is done (or the sim completes and
            auto-advances the phase), this stays gone instead of
            resurfacing a confusing "restart the draft?" prompt during
            Final Adjustments. */}
        {match.state === "DRAFT_STARTED" && (
          <div className="border border-white/10 rounded-lg p-3 space-y-3">
            {!draftSim ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-white/50">Draft simulation — pick Blue side (first pick, first ban):</span>
                {match.team_a && (
                  <button onClick={() => startDraftSimulation(match.team_a!.id)} className="lv-btn-ghost !text-xs">
                    {match.team_a.name} is Blue
                  </button>
                )}
                {match.team_b && (
                  <button onClick={() => startDraftSimulation(match.team_b!.id)} className="lv-btn-ghost !text-xs">
                    {match.team_b.name} is Blue
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm font-semibold">
                    {DRAFT_SEQUENCE[draftSim.stepIndex].side === "blue"
                      ? draftSim.blueTeamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name
                      : draftSim.redTeamId === match.team_a?.id ? match.team_a?.name : match.team_b?.name}
                    {" — "}
                    <span className={DRAFT_SEQUENCE[draftSim.stepIndex].type === "ban" ? "text-red-400" : "text-emerald-400"}>
                      {draftStepLabel(draftSim.stepIndex)}
                    </span>
                    <span className="text-white/30 text-xs"> ({draftSim.stepIndex + 1}/{DRAFT_SEQUENCE.length})</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={undoLastDraftStep}
                      disabled={draftSim.stepIndex === 0}
                      title="Undo the last pick/ban — removes it from Hero picks & bans and the Moment list"
                      className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ↩ Undo
                    </button>
                    <button onClick={stopDraftSimulation} className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10">
                      Stop
                    </button>
                    <button onClick={resetDraftSimulation} className="text-xs border border-red-500/30 text-red-300 rounded px-2 py-1 hover:bg-red-500/10">
                      Reset draft
                    </button>
                  </div>
                </div>
                <input
                  value={simHeroSearch}
                  onChange={(e) => setSimHeroSearch(e.target.value)}
                  placeholder="Search heroes..."
                  className="w-full bg-white/10 border border-white/10 rounded px-3 py-1.5 text-xs"
                />
                <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2 max-h-64 overflow-y-auto">
                  {heroes
                    .filter((h) => h.name.toLowerCase().includes(simHeroSearch.toLowerCase()))
                    .map((h) => {
                      const taken = draftSim.committed.some((c) => c.heroName.toLowerCase() === h.name.toLowerCase());
                      return (
                        <button
                          key={h.id}
                          onClick={() => logSimulationStep(h.name)}
                          disabled={taken}
                          title={h.name}
                          className={`flex flex-col items-center gap-1 group ${taken ? "opacity-30 cursor-not-allowed" : ""}`}
                        >
                          <HeroIcon url={h.icon_url} name={h.name} size="sm" />
                          <span className="text-[9px] text-white/60 group-hover:text-white text-center leading-tight truncate w-full">
                            {h.name}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Broadcast-style draft board — THE editing surface for
            hero_picks_bans, not just a presentation layer. Player photos
            flip to hero icons as each pick lands (via pickBans' own
            player_id, set either by clicking an empty slot directly or by
            the post-sim "assign player" step below), the acting side glows
            while draftSim has a live turn, and — whenever editable —
            clicking any slot opens the shared hero picker: filled slots to
            correct (auto-swapping with a teammate if the new hero is
            already theirs), empty slots to add a fresh pick/ban. Stays
            mounted through GAME_STARTED too, purely for that
            correct-by-click ability, since a hero can still turn out
            misattributed after the game's already live. */}
        {(DRAFT_PHASES.includes(match.state) || match.state === "GAME_STARTED") && match.team_a && match.team_b && (
          <DraftOverlay
            leftTeam={overlayLeftTeam}
            rightTeam={overlayRightTeam}
            leftPlayers={overlayLeftPlayers}
            rightPlayers={overlayRightPlayers}
            pickBans={pickBans as DraftOverlayPickBan[]}
            heroIconFor={heroIconFor}
            stageLabel={overlayStageLabel}
            phaseLabel={overlayPhaseLabel}
            turnSide={overlayTurnSide}
            turnLabel={overlayTurnLabel}
            stepProgress={overlayStepProgress}
            interactive={pickBanEditable && !draftSim}
            onSlotClick={handleDraftSlotClick}
            onSwapClick={pickBanEditable ? handleSwapClick : undefined}
            swapSelectedPlayerId={swapSource?.playerId ?? null}
          />
        )}

        {/* Roster setup — the one-time step before a draft starts: fix a
            typo'd IGN or wrong role, bench/activate down to exactly 5 a
            side, then start the draft right here instead of hunting for
            the phase dropdown in the sticky header above. Replaces what
            used to be silent hunting for "why won't Draft started take" —
            handlePhaseChange still owns the actual 5/5 gate, this panel
            just surfaces it inline with a button that acts on it directly. */}
        {match.state === "MATCH_NOT_STARTED" && (
          <div className="border border-white/10 rounded-lg p-3 space-y-3">
            <p className="text-xs text-white/50">
              Roster setup — confirm who&apos;s playing and fix any name/role before the draft starts.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[match.team_a, match.team_b].map((team, idx) => {
                if (!team) return <span key={idx} />;
                const teamRoster = rosterFor(team.id);
                const activeCount = teamRoster.filter((p) => p.is_active_roster).length;
                return (
                  <div key={team.id} className="space-y-1.5">
                    <p className="text-xs text-white/50">
                      {team.name} — active roster{" "}
                      <span className={activeCount === 5 ? "text-emerald-400" : "text-yellow-300"}>{activeCount}/5</span>
                    </p>
                    <div className="space-y-1">
                      {teamRoster.map((p) =>
                        editingRosterPlayerId === p.id ? (
                          <div key={p.id} className="flex items-center gap-1.5 border border-signal/40 rounded px-2 py-1.5 bg-white/5">
                            <input
                              autoFocus
                              value={editingRosterIgn}
                              onChange={(e) => setEditingRosterIgn(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && saveRosterPlayerEdit(p.id)}
                              placeholder="IGN"
                              className="flex-1 min-w-0 bg-white/10 border border-white/10 rounded px-2 py-1 text-xs"
                            />
                            <select
                              value={editingRosterRole}
                              onChange={(e) => setEditingRosterRole(e.target.value)}
                              className="bg-white/10 border border-white/10 rounded px-2 py-1 text-xs shrink-0"
                            >
                              <option value="">No role</option>
                              {ROLE_ORDER.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                            <button onClick={() => saveRosterPlayerEdit(p.id)} className="lv-btn-primary !px-2 !py-1 !text-xs shrink-0">
                              Save
                            </button>
                            <button onClick={() => setEditingRosterPlayerId(null)} className="lv-btn-ghost !px-2 !py-1 !text-xs shrink-0">
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div key={p.id} className="flex items-center gap-1.5">
                            <button
                              onClick={() => toggleActiveRoster(p.id, !p.is_active_roster)}
                              className={`flex-1 min-w-0 text-left text-[11px] rounded px-2 py-1.5 border truncate ${
                                p.is_active_roster
                                  ? "border-signal/40 bg-signal/10 text-white"
                                  : "border-white/10 text-white/40 hover:border-white/30"
                              }`}
                              title={p.is_active_roster ? "Active — click to bench" : "Bench — click to activate"}
                            >
                              {p.is_active_roster ? "✓ " : ""}
                              {p.ign}
                              {p.role ? ` (${p.role})` : ""}
                            </button>
                            <button
                              onClick={() => startEditRosterPlayer(p)}
                              title="Edit IGN / role"
                              className="text-white/30 hover:text-white shrink-0 text-xs px-1.5 py-1.5"
                            >
                              ✎
                            </button>
                            <button
                              onClick={() => removeRosterPlayer(p)}
                              title="Remove from roster (team-wide, not just this match)"
                              className="text-white/30 hover:text-red-400 shrink-0 text-xs px-1.5 py-1.5"
                            >
                              🗑
                            </button>
                          </div>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 pt-1">
                      <input
                        value={newRosterName[team.id] ?? ""}
                        onChange={(e) => setNewRosterName((prev) => ({ ...prev, [team.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && addRosterPlayer(team.id)}
                        placeholder="New player IGN"
                        className="flex-1 min-w-0 bg-white/10 border border-dashed border-white/20 rounded px-2 py-1.5 text-xs"
                      />
                      <button
                        onClick={() => addRosterPlayer(team.id)}
                        disabled={!(newRosterName[team.id] ?? "").trim()}
                        className="lv-btn-ghost !px-2 !py-1.5 !text-xs shrink-0 disabled:opacity-40"
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {(() => {
              const aActive = match.team_a ? rosterFor(match.team_a.id).filter((p) => p.is_active_roster).length : 0;
              const bActive = match.team_b ? rosterFor(match.team_b.id).filter((p) => p.is_active_roster).length : 0;
              const ready = aActive === 5 && bActive === 5;
              return (
                <div className="flex items-center gap-3 pt-1 border-t border-white/10">
                  <button
                    onClick={() => handlePhaseChange("DRAFT_STARTED")}
                    disabled={!ready}
                    className="lv-btn-primary !text-xs disabled:opacity-40"
                  >
                    ▶ Start draft
                  </button>
                  <span className={`text-xs ${ready ? "text-emerald-400" : "text-white/40"}`}>
                    {ready ? "Both rosters ready." : `Needs exactly 5 active a side (currently ${aActive}/5, ${bActive}/5).`}
                  </span>
                </div>
              );
            })()}
          </div>
        )}

        {/* Active roster (main lineup) — bench/activate stays editable
            through Draft complete (not locked the instant the draft
            starts, per spec), but IGN/role editing is Roster setup-only
            above — renaming mid-draft isn't this panel's job. */}
        {DRAFT_PHASES.includes(match.state) && (
          <div className="border border-white/10 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[match.team_a, match.team_b].map((team, idx) => {
              if (!team) return <span key={idx} />;
              const teamRoster = rosterFor(team.id);
              const activeCount = teamRoster.filter((p) => p.is_active_roster).length;
              return (
                <div key={team.id} className="space-y-1.5">
                  <p className="text-xs text-white/50">
                    {team.name} — active roster{" "}
                    <span className={activeCount === 5 ? "text-emerald-400" : "text-yellow-300"}>{activeCount}/5</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {teamRoster.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => toggleActiveRoster(p.id, !p.is_active_roster)}
                        className={`text-[10px] rounded px-2 py-1 border ${
                          p.is_active_roster
                            ? "border-signal/40 bg-signal/10 text-white"
                            : "border-white/10 text-white/40 hover:border-white/30"
                        }`}
                        title={p.is_active_roster ? "Active — click to bench" : "Bench — click to activate"}
                      >
                        {p.is_active_roster ? "✓ " : ""}
                        {p.ign}
                        {p.role ? ` (${p.role})` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Substitute (not-in-roster) player — the normal case no longer
            needs an assignment step at all: the draft board above already
            positionally matches each team's Nth pick to their Nth roster
            player automatically (see DraftOverlay's file comment), and the
            ⇄ swap button on each portrait fixes it when the actual draft
            order didn't go role-by-role. This is only for the genuine edge
            case — a sub who isn't one of the 5 active roster players at
            all — kept as a lightweight prompt() flow (matching this page's
            existing pattern for other rare admin-only actions, e.g.
            handlePromote) rather than its own dropdown UI for something
            that rarely comes up. */}
        {match.state === "DRAFT_COMPLETE" &&
          [match.team_a, match.team_b].some(
            (team) => team && pickBans.some((pb) => pb.team_id === team.id && pb.type === "pick" && !pb.custom_player_name)
          ) && (
            <div className="flex flex-wrap gap-2">
              {[match.team_a, match.team_b].map((team) => {
                if (!team) return null;
                const picks = pickBans
                  .filter((pb) => pb.team_id === team.id && pb.type === "pick" && !pb.custom_player_name)
                  .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
                if (picks.length === 0) return null;
                return (
                  <button
                    key={team.id}
                    onClick={() => {
                      const list = picks.map((pb, i) => `${i + 1}. ${pb.hero_name}`).join("\n");
                      const choice = prompt(`${team.name} — which pick was actually played by a substitute?\n\n${list}\n\nEnter a number:`);
                      const idx = Number(choice) - 1;
                      if (!choice || idx < 0 || idx >= picks.length) return;
                      addCustomPlayerToPick(picks[idx].id);
                    }}
                    className="text-xs border border-white/10 rounded px-2 py-1 hover:bg-white/10 text-white/50"
                  >
                    + Mark a {team.name} pick as a substitute
                  </button>
                );
              })}
            </div>
          )}

        {/* Reused by the draft board's click-a-slot flow (see
            onSlotClick={handleDraftSlotClick} above) — clicking any filled
            slot on the board reopens this same modal targeted at that one
            row, so this modal is squarely in the "does the draft board
            draft overlay actually work on a phone" path. Outer padding
            shrunk below sm so the hero grid gets its full width back
            instead of losing 48px to backdrop padding it doesn't need on
            a screen that's already narrow; sm: restores the original p-6. */}
        {showHeroPicker && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-6"
            onClick={closeHeroPicker}
          >
            <div
              className="bg-ink border border-white/10 rounded-lg p-4 max-w-3xl w-full max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-sm">
                  {!heroPickerTarget
                    ? "Hero reference — browse only"
                    : heroPickerTarget.mode === "correct"
                    ? `Correct ${heroPickerTarget.pb.type} — ${heroPickerTarget.label}`
                    : heroPickerTarget.mode === "add-pick"
                    ? `Add pick — ${heroPickerTarget.label}`
                    : `Add ban — ${heroPickerTarget.label}`}
                </h3>
                <div className="flex items-center gap-2">
                  {heroPickerTarget?.mode === "correct" && pickBanEditable && (
                    <button
                      onClick={() => {
                        deletePickBan(heroPickerTarget.pb.id);
                        closeHeroPicker();
                      }}
                      className="text-xs border border-red-500/30 text-red-400 rounded px-2 py-1 hover:bg-red-500/10"
                    >
                      🗑 Remove
                    </button>
                  )}
                  <button onClick={closeHeroPicker} className="text-white/40 hover:text-white/70 text-sm">✕</button>
                </div>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
                {heroes.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      if (heroPickerTarget?.mode === "correct") {
                        assignOrSwapHero(heroPickerTarget.pb, h.name);
                      } else if (heroPickerTarget?.mode === "add-pick") {
                        addPickForPlayer(heroPickerTarget.teamId, heroPickerTarget.playerId, h.name);
                      } else if (heroPickerTarget?.mode === "add-ban") {
                        addBanForTeam(heroPickerTarget.teamId, h.name);
                      }
                      closeHeroPicker();
                    }}
                    className="flex flex-col items-center gap-1 group"
                  >
                    <HeroIcon url={h.icon_url} name={h.name} size="md" />
                    <span className="text-[10px] text-white/60 group-hover:text-white text-center leading-tight">{h.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </details>


      {!isEditable && (
        <p className="lv-alert-warning">
          This match is scheduled — result, game result, draft/picks-bans, moment log, and OCR capture are locked
          until it&apos;s set live (needs a stream link on the Matches page) or marked finished. The roster fixes in
          Live scoreboard above stay available.
        </p>
      )}

      {isContributor && (
        <div className="lv-card-flush p-4 space-y-3 border-signal/30">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Contributor mode</p>
              <p className="text-xs text-white/50">
                {finishedEditUnlocked
                  ? "Every change below is staged locally, not saved — submit when you're done and an admin will review it."
                  : `Click "${editingFinishedGame ? "🔓 Editing finished game" : "🔒 Unlock to edit"}" below to start staging corrections.`}
              </p>
            </div>
            <button
              onClick={submitMatchEditRequest}
              disabled={pendingMatchEdits.length === 0 || submittingMatchEdits}
              className="lv-btn-primary !text-xs !py-1.5 disabled:opacity-40"
            >
              {submittingMatchEdits ? "Submitting..." : `Submit edit request (${pendingMatchEdits.length})`}
            </button>
          </div>
          {pendingMatchEdits.length > 0 && (
            <ul className="text-xs text-white/60 space-y-1 max-h-32 overflow-y-auto">
              {pendingMatchEdits.map((e, i) => (
                <li key={i}>
                  <span className="text-white/40">{e.table}</span> · {e.action}
                </li>
              ))}
            </ul>
          )}
          {matchEditSubmitNotice && <p className="text-sm text-signal">{matchEditSubmitNotice}</p>}
        </div>
      )}

      {/* Game selector and Map are now at the top of the monitor pane
          (left column), next to Declare Game Winner — see there. Only the
          game history block stays here. */}
      <div className="border border-white/10 rounded-lg p-3 space-y-4">
      {/* Game history — the per-game results that previously showed nowhere in this console */}
      {pastGames.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold text-sm text-white/60">Other games</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {pastGames.map((g) => (
              <span key={g.id} className="px-3 py-1.5 rounded bg-white/5 border border-white/10 inline-flex items-center gap-1.5">
                Game {g.game_number}
                {g.map && <span className="text-white/40"> · {g.map}</span>} —{" "}
                <strong>{g.winner_team_id === match.team_a?.id ? match.team_a?.name : g.winner_team_id === match.team_b?.id ? match.team_b?.name : "no winner set"}</strong>
                {/* Correcting a past result after the fact — distinct from
                    declareGameWinner, which is for closing out a game the
                    first time and posts a new Telegram/moment event. */}
                {isEditable && match.team_a && match.team_b && (
                  <span className="flex gap-1 ml-1">
                    {[match.team_a, match.team_b].map((t) =>
                      t.id === g.winner_team_id ? null : (
                        <button
                          key={t.id}
                          onClick={() => correctGameWinner(g.id, t.id)}
                          className="text-white/30 hover:text-signal normal-case"
                          title={`Correct: ${t.name} actually won Game ${g.game_number}`}
                        >
                          → {t.name}
                        </button>
                      )
                    )}
                  </span>
                )}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Public clock source moved to the top of this column, above the
          Moment Timeline — see there. Net worth and Game screenshots moved
          up to sit right after "Log a moment", in the same combined panel
          as Objectives/Live scoreboard — see there. */}
      </div>

      {match.update_source !== "local_ocr" && (
        <p className="text-xs text-white/40 border border-white/10 rounded px-3 py-2">
          This is a Normal match — KDA, screenshots, and the moment log aren&apos;t tracked here (Liquipedia-only
          data: picks/bans, score, stream, VOD). Switch to Hot match above to take manual/OCR control.
        </p>
      )}

          </div>

          {/* A second, compact "Moment Timeline" widget used to live here —
              exact same keyMoments data, same edit/delete/undo, just the 5
              most recent instead of the full scrollable list in the
              "Moment Timeline" section above. It made sense back when this
              was its own third column (a some-of-it-always-visible glance
              panel while the fuller list sat elsewhere); now that both
              live in the same scrollable action deck, one above the other,
              it was showing the same moments twice with two separate edit
              controls for the same rows. Removed — the section above is
              the one Moment Timeline. */}
        </div>
      </div>

      {telegramStatus && (
        <p className="text-xs text-white/50 fixed bottom-4 right-4 bg-black/80 border border-white/10 rounded px-3 py-2 z-50">
          {telegramStatus}
        </p>
      )}

      {undoStatus && (
        <p className="text-xs text-emerald-300 fixed bottom-16 right-4 bg-black/80 border border-emerald-500/30 rounded px-3 py-2 z-50">
          {undoStatus}
        </p>
      )}

      {/* Action errors (rejected phase change, blocked delete, etc.) —
          a dismissible toast, not a page teardown. See the comment above
          the match/game null-check for why this changed. */}
      {error && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-sm bg-red-500/15 border border-red-500/40 rounded px-3 py-2 z-50 flex items-start gap-2">
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-300/60 hover:text-red-300 text-xs shrink-0">✕</button>
        </div>
      )}

    </div>
  );
}
