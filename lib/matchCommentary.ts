// Auto-commentary engine — turns the live game state (and how it changed since
// the last sample) into natural, caster-style one-liners for the Moment list.
// Pure and deterministic given an RNG, so it is unit-tested and reused by the
// admin capture loop, which fires it on a randomized ~1-2 minute cadence.
//
// Two sources of phrasing, merged:
//   1. BUILT-IN defaults (shipped in code, always available).
//   2. ADMIN templates from the DB (`commentary_templates`), editable in the
//      /admin/commentary UI with NO deploy.
// Both are `{placeholder}` templates rendered against the facts a condition
// produces this sample. Each condition (net worth, kills, objectives, player
// KDA, win probability, hero flavor, pacing) can be toggled on/off by the
// operator. The trigger logic — WHEN a line is eligible — stays in code; the
// TEXT is fully editable.

export type CommentaryCondition =
  | "net_worth"
  | "kills"
  | "tower"
  | "turtle"
  | "lord"
  | "player_kda"
  | "win_prob"
  | "hero"
  | "general";

export const COMMENTARY_CONDITIONS: { key: CommentaryCondition; label: string }[] = [
  { key: "net_worth", label: "Net worth (lead / comeback)" },
  { key: "kills", label: "Team kills (fights / leads)" },
  { key: "tower", label: "Towers" },
  { key: "turtle", label: "Turtle" },
  { key: "lord", label: "Lord" },
  { key: "player_kda", label: "Player K/D/A (carries / shutdowns)" },
  { key: "win_prob", label: "Win probability / momentum" },
  { key: "hero", label: "Hero & player flavor" },
  { key: "general", label: "General pacing / hype" },
];

// Placeholders each condition can supply, for the admin editor's help text.
// A custom template only fires on a trigger that supplies EVERY placeholder it
// uses (see renderTemplate) — so e.g. "{trail} closes to {diff}" only appears on
// the comeback trigger, not the plain-lead one.
export const COMMENTARY_PLACEHOLDERS: Record<CommentaryCondition, { token: string; desc: string }[]> = {
  net_worth: [
    { token: "{lead}", desc: "team in front on gold" },
    { token: "{trail}", desc: "team behind on gold" },
    { token: "{diff}", desc: "gold gap, e.g. 14.0k" },
    { token: "{closed}", desc: "gold clawed back since last sample (comeback)" },
  ],
  kills: [
    { token: "{lead}", desc: "team ahead on kills" },
    { token: "{trail}", desc: "team behind on kills" },
    { token: "{hi}", desc: "higher kill count" },
    { token: "{lo}", desc: "lower kill count" },
    { token: "{count}", desc: "kills in the latest flurry" },
    { token: "{scorer}", desc: "team that just got a kill" },
  ],
  tower: [
    { token: "{team}", desc: "team that just took a tower" },
    { token: "{count}", desc: "that team's tower total" },
    { token: "{leader}", desc: "team leading on towers" },
    { token: "{hi}", desc: "higher tower total" },
    { token: "{lo}", desc: "lower tower total" },
  ],
  turtle: [{ token: "{team}", desc: "team that took Turtle" }],
  lord: [{ token: "{team}", desc: "team that took Lord" }],
  player_kda: [
    { token: "{player}", desc: "player name" },
    { token: "{hero}", desc: "hero name (if known)" },
    { token: "{k}", desc: "kills" },
    { token: "{d}", desc: "deaths" },
    { token: "{a}", desc: "assists" },
    { token: "{ka}", desc: "kills + assists" },
  ],
  win_prob: [
    { token: "{favored}", desc: "team favored by the model" },
    { token: "{pct}", desc: "their win chance, e.g. 90" },
    { token: "{to}", desc: "team momentum is swinging to" },
  ],
  hero: [
    { token: "{player}", desc: "player name" },
    { token: "{hero}", desc: "hero name" },
  ],
  general: [],
};

export type CommentaryTeam = { id: string; name: string };
export type CommentaryPlayer = {
  id: string;
  name: string;
  teamId: string;
  kills: number;
  deaths: number;
  assists: number;
  heroName?: string | null;
};

export type CommentarySnapshot = {
  timerSeconds: number;
  teamA: CommentaryTeam;
  teamB: CommentaryTeam;
  netWorth: Record<string, number>; // teamId → gold
  teamKills: Record<string, number>; // teamId → kills
  objectives: Record<string, { turtle: number; lord: number; tower: number }>; // teamId → counts
  players: CommentaryPlayer[];
  winProbA: number; // 0..1 probability team A wins
};

// An admin-authored template row (a subset of the DB shape the engine needs).
export type CommentaryTemplate = { condition: CommentaryCondition; template: string; enabled: boolean };

export type CommentaryLine = { text: string; condition: CommentaryCondition; source: "builtin" | "custom" };

export type CommentaryContext = {
  now: CommentarySnapshot;
  prev: CommentarySnapshot | null;
  enabled: Set<CommentaryCondition>;
};

type Rng = () => number; // [0,1)
type Facts = Record<string, string | number>;
// A fired eligibility: a condition, the facts it exposes, and its built-in text.
type Trigger = { condition: CommentaryCondition; facts: Facts; defaults: string[] };

function pick<T>(rng: Rng, arr: T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
function nw(s: CommentarySnapshot, teamId: string): number {
  return s.netWorth[teamId] ?? 0;
}
function tk(s: CommentarySnapshot, teamId: string): number {
  return s.teamKills[teamId] ?? 0;
}
function objc(s: CommentarySnapshot, teamId: string, k: "turtle" | "lord" | "tower"): number {
  return s.objectives[teamId]?.[k] ?? 0;
}
function goldK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}
function leaderByNet(s: CommentarySnapshot): { lead: CommentaryTeam; trail: CommentaryTeam; diff: number } {
  const a = nw(s, s.teamA.id);
  const b = nw(s, s.teamB.id);
  return a >= b
    ? { lead: s.teamA, trail: s.teamB, diff: a - b }
    : { lead: s.teamB, trail: s.teamA, diff: b - a };
}

// Render a `{placeholder}` template against facts. Returns null if the template
// references any placeholder the current trigger did NOT supply — so a template
// only ever fires where all its variables make sense.
export function renderTemplate(tpl: string, facts: Facts): string | null {
  let ok = true;
  const out = tpl.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key in facts) return String(facts[key]);
    ok = false;
    return "";
  });
  return ok ? out.replace(/\s+/g, " ").trim() : null;
}

// One generator per condition kind, each returning zero or more fired triggers.
type Generator = (ctx: CommentaryContext) => Trigger[];

const generators: Generator[] = [
  // ── net worth: dominating / close / comeback / flip ───────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const { lead, trail, diff } = leaderByNet(now);
    const out: Trigger[] = [];
    if (diff >= 10000) {
      out.push({ condition: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
        "{lead} are running away with this — a {diff} gold lead.",
        "It's turning into a stranglehold; {lead} up {diff} in net worth.",
        "{lead} in complete control of the gold, ahead by {diff}.",
      ] });
    } else if (diff <= 2000) {
      out.push({ condition: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(Math.max(diff, 500)) }, defaults: [
        "Dead even on gold — less than {diff} between them.",
        "Anyone's game here, the net worth is razor thin.",
        "Neck and neck; neither side can find a gold cushion.",
      ] });
    } else if (diff >= 4000) {
      out.push({ condition: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
        "{lead} nose in front by {diff} in gold.",
        "A working advantage for {lead}, {diff} up on net worth.",
      ] });
    }
    if (prev) {
      const pl = leaderByNet(prev);
      if (pl.lead.id === lead.id && pl.diff - diff >= 2500) {
        out.push({ condition: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff), closed: goldK(pl.diff - diff) }, defaults: [
          "{trail} clawing back — they've shaved {closed} off the deficit.",
          "The gap is closing; {trail} back within {diff}.",
        ] });
      }
      if (pl.lead.id !== lead.id && diff >= 1500) {
        out.push({ condition: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
          "Lead has flipped — {lead} now ahead on gold.",
          "Momentum swing! {lead} have taken over the net worth lead.",
        ] });
      }
    }
    return out;
  },

  // ── team kills: leads and fights ──────────────────────────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const a = tk(now, now.teamA.id);
    const b = tk(now, now.teamB.id);
    const out: Trigger[] = [];
    const [lead, trail, hi, lo] = a >= b ? [now.teamA, now.teamB, a, b] : [now.teamB, now.teamA, b, a];
    if (hi - lo >= 6) {
      out.push({ condition: "kills", facts: { lead: lead.name, trail: trail.name, hi, lo, a, b }, defaults: [
        "{lead} bullying the scoreboard, {hi}–{lo} on kills.",
        "{lead} with a commanding {hi}–{lo} kill lead.",
      ] });
    } else if (hi + lo >= 6 && hi - lo <= 2) {
      out.push({ condition: "kills", facts: { lead: lead.name, trail: trail.name, hi, lo, a, b }, defaults: [
        "Bloodbath and it's even — {hi}–{lo} on the kill count.",
        "Both teams trading everything, {a}–{b} in kills.",
      ] });
    }
    if (prev) {
      const totalNow = a + b;
      const totalPrev = tk(prev, now.teamA.id) + tk(prev, now.teamB.id);
      const gained = totalNow - totalPrev;
      if (gained >= 3) {
        out.push({ condition: "kills", facts: { lead: lead.name, trail: trail.name, count: gained, hi, lo }, defaults: [
          "Teamfight just erupted — {count} kills in a blink.",
          "A skirmish breaks out, {count} down in quick succession.",
        ] });
      } else if (gained >= 1) {
        const scorer = tk(now, lead.id) - tk(prev, lead.id) > 0 ? lead : trail;
        out.push({ condition: "kills", facts: { scorer: scorer.name, lead: lead.name, trail: trail.name, count: gained }, defaults: [
          "{scorer} pick up a kill to keep the pressure on.",
          "The next one goes to {scorer}.",
        ] });
      }
    }
    return out;
  },

  // ── objectives: tower ─────────────────────────────────────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const out: Trigger[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = objc(now, team.id, "tower");
      const was = prev ? objc(prev, team.id, "tower") : cur;
      if (prev && cur > was) {
        out.push({ condition: "tower", facts: { team: team.name, count: cur }, defaults: [
          "{team} crack another tower — up to {count} now.",
          "Structure falls; {team} take tower number {count}.",
          "{team} keep chipping the map, {count} towers down.",
        ] });
      }
    }
    const ta = objc(now, now.teamA.id, "tower");
    const tb = objc(now, now.teamB.id, "tower");
    if (Math.abs(ta - tb) >= 3) {
      const leader = ta > tb ? now.teamA : now.teamB;
      out.push({ condition: "tower", facts: { leader: leader.name, hi: Math.max(ta, tb), lo: Math.min(ta, tb) }, defaults: [
        "{leader} own the map — {hi} towers to {lo}.",
      ] });
    }
    return out;
  },

  // ── objectives: turtle ────────────────────────────────────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const out: Trigger[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = objc(now, team.id, "turtle");
      const was = prev ? objc(prev, team.id, "turtle") : cur;
      if (prev && cur > was) {
        out.push({ condition: "turtle", facts: { team: team.name }, defaults: [
          "{team} slam the Turtle for the gold and buff.",
          "Turtle goes to {team} — a tidy pickup.",
        ] });
      }
    }
    return out;
  },

  // ── objectives: lord ──────────────────────────────────────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const out: Trigger[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = objc(now, team.id, "lord");
      const was = prev ? objc(prev, team.id, "lord") : cur;
      if (prev && cur > was) {
        out.push({ condition: "lord", facts: { team: team.name }, defaults: [
          "{team} secure the LORD — this could be the game-ender.",
          "Lord is down and it belongs to {team}. Massive.",
          "{team} take Lord and now they march.",
        ] });
      }
    }
    return out;
  },

  // ── player KDA: unkillable / carry / shutdown ─────────────────────────
  (ctx) => {
    const { now } = ctx;
    const out: Trigger[] = [];
    const star = [...now.players].sort((a, b) => b.kills + b.assists - (a.kills + a.assists))[0];
    if (star && star.kills >= 4 && star.deaths === 0) {
      out.push({ condition: "player_kda", facts: { player: star.name, k: star.kills, d: star.deaths, a: star.assists, ka: star.kills + star.assists }, defaults: [
        "{player} is unkillable — {k} kills and yet to fall.",
        "Nobody can touch {player}: {k}/{d}/{a}.",
      ] });
    } else if (star && star.kills + star.assists >= 8) {
      out.push({ condition: "player_kda", facts: { player: star.name, k: star.kills, d: star.deaths, a: star.assists, ka: star.kills + star.assists }, defaults: [
        "{player} is taking over — {k}/{d}/{a} on the board.",
        "{player} everywhere on the map, already {ka} takedowns involved.",
      ] });
    }
    const feeder = [...now.players].sort((a, b) => b.deaths - a.deaths)[0];
    if (feeder && feeder.deaths >= 4 && feeder.deaths > feeder.kills + 1) {
      out.push({ condition: "player_kda", facts: { player: feeder.name, k: feeder.kills, d: feeder.deaths, a: feeder.assists, ka: feeder.kills + feeder.assists }, defaults: [
        "Rough one for {player}, caught out {d} times now.",
        "{player} can't buy a break — down {d} deaths.",
      ] });
    }
    return out;
  },

  // ── win probability / momentum ────────────────────────────────────────
  (ctx) => {
    const { now, prev } = ctx;
    const out: Trigger[] = [];
    const p = now.winProbA;
    const favored = p >= 0.5 ? now.teamA : now.teamB;
    const favPct = Math.round((p >= 0.5 ? p : 1 - p) * 100);
    if (favPct >= 85) {
      out.push({ condition: "win_prob", facts: { favored: favored.name, pct: favPct }, defaults: [
        "The model has {favored} firmly in front — {pct}% to close it out.",
        "{favored} in the driver's seat at {pct}% win chance.",
      ] });
    }
    if (prev) {
      const shift = now.winProbA - prev.winProbA;
      if (Math.abs(shift) >= 0.1) {
        const to = shift > 0 ? now.teamA : now.teamB;
        out.push({ condition: "win_prob", facts: { to: to.name }, defaults: [
          "Momentum swinging toward {to} on the win-probability read.",
          "The needle moves for {to} — this is where games turn.",
        ] });
      }
    }
    return out;
  },

  // ── hero & player flavor ──────────────────────────────────────────────
  (ctx) => {
    const { now } = ctx;
    const withHero = now.players.filter((p) => p.heroName);
    if (withHero.length === 0) return [];
    const star = [...withHero].sort((a, b) => b.kills + b.assists - (a.kills + a.assists))[0];
    return [{ condition: "hero", facts: { player: star.name, hero: star.heroName as string }, defaults: [
      "{hero} in the hands of {player} is a real problem right now.",
      "Watch the {hero} — {player} is finding all the angles.",
      "{player}'s {hero} looking like the pick of the draft.",
    ] }];
  },

  // ── general pacing / hype ─────────────────────────────────────────────
  (ctx) => {
    const { now } = ctx;
    const m = Math.floor(now.timerSeconds / 60);
    if (m < 5) {
      return [{ condition: "general", facts: {}, defaults: [
        "Still early doors — both sides settling into the farm.",
        "Opening exchanges, feeling each other out.",
      ] }];
    } else if (m < 12) {
      return [{ condition: "general", facts: {}, defaults: [
        "Mid game and the map is opening up — objectives on the horizon.",
        "Rotations getting sharper as we hit the mid game.",
      ] }];
    }
    return [{ condition: "general", facts: {}, defaults: [
      "Deep into the late game — one fight decides it from here.",
      "Every pick matters now; there's no respawning your way out of a bad one.",
    ] }];
  },
];

export type CommentaryOptions = { rng?: Rng; templates?: CommentaryTemplate[] };

// Build the full candidate set for the current context — built-in phrasings PLUS
// any enabled admin templates for a fired condition — respecting the enabled
// toggles. Used by tests and by weighted selection.
export function commentaryCandidates(ctx: CommentaryContext, opts: CommentaryOptions = {}): CommentaryLine[] {
  const templates = opts.templates ?? [];
  const lines: CommentaryLine[] = [];
  for (const g of generators) {
    for (const trig of g(ctx)) {
      if (!ctx.enabled.has(trig.condition)) continue;
      for (const d of trig.defaults) {
        const t = renderTemplate(d, trig.facts);
        if (t) lines.push({ condition: trig.condition, text: t, source: "builtin" });
      }
      for (const tpl of templates) {
        if (!tpl.enabled || tpl.condition !== trig.condition) continue;
        const t = renderTemplate(tpl.template, trig.facts);
        if (t) lines.push({ condition: trig.condition, text: t, source: "custom" });
      }
    }
  }
  return lines;
}

// Pick ONE natural line for this sample, or null if nothing noteworthy is
// enabled/true. Event-driven lines (a fight, an objective, a swing) are
// preferred over ambient pacing filler so the feed reacts to the game.
export function pickCommentary(ctx: CommentaryContext, opts: CommentaryOptions = {}): CommentaryLine | null {
  const rng = opts.rng ?? Math.random;
  const all = commentaryCandidates(ctx, opts);
  if (all.length === 0) return null;
  const eventDriven = all.filter((l) => l.condition !== "general");
  const pool = eventDriven.length > 0 ? eventDriven : all;
  return pick(rng, pool);
}
