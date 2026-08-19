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
//
// Anti-repetition: the caller passes the recently-posted line texts and the
// recently-spotlighted subjects (a player/hero name, or a condition key). The
// picker drops any exact line it just used and de-prioritizes any line whose
// subject was just spotlighted — so the feed stops hammering the same player,
// the same hero, or the same phrasing over and over.

import { ID_TEMPLATES, ID_WINPROB } from "./commentaryId.ts";

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
// `id` is optional so tests can pass bare templates; when present it flows onto
// the picked line as `templateId`, letting the caller bump that row's use_count.
// `lang` scopes the row to ONE language — the EN and ID libraries are fully
// independent (adding a line in ID mode adds only an ID row). The engine only
// renders rows whose lang matches the active language. Older callers that omit
// lang are treated as English.
export type CommentaryTemplate = { id?: string; condition: CommentaryCondition; template: string; lang?: CommentaryLang; enabled: boolean };

// `subject` is the thing this line spotlights (a player/hero name, or a coarse
// key like "net_worth"/"kills"). The picker uses it to avoid re-spotlighting the
// same subject on consecutive samples.
export type CommentaryLine = { text: string; condition: CommentaryCondition; source: "builtin" | "custom"; subject?: string; templateId?: string };

export type CommentaryContext = {
  now: CommentarySnapshot;
  prev: CommentarySnapshot | null;
  enabled: Set<CommentaryCondition>;
};

export type CommentaryLang = "en" | "id";
type Rng = () => number; // [0,1)
type Facts = Record<string, string | number>;
// A fired eligibility: a condition, the facts it exposes, its built-in text, and
// the subject it spotlights (for anti-repetition).
type Trigger = { condition: CommentaryCondition; facts: Facts; defaults: string[]; subject?: string };

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
function teamNameOf(s: CommentarySnapshot, teamId: string): string {
  return teamId === s.teamA.id ? s.teamA.name : teamId === s.teamB.id ? s.teamB.name : "";
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
      out.push({ condition: "net_worth", subject: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
        "{lead} are running away with this — a {diff} gold lead.",
        "It's turning into a stranglehold; {lead} up {diff} in net worth.",
        "{lead} in complete control of the gold, ahead by {diff}.",
        "This is a landslide on the economy — {lead} plus {diff}.",
        "{lead} have broken the game open, {diff} clear on gold.",
        "The net worth gap is brutal now: {lead} up {diff}.",
        "{lead} snowballing hard, a {diff} advantage and climbing.",
      ] });
    } else if (diff <= 2000) {
      out.push({ condition: "net_worth", subject: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(Math.max(diff, 500)) }, defaults: [
        "Dead even on gold — less than {diff} between them.",
        "Anyone's game here, the net worth is razor thin.",
        "Neck and neck; neither side can find a gold cushion.",
        "You couldn't slide a coin between these two on gold.",
        "The economy is a stalemate — under {diff} separating them.",
        "Nothing to choose on net worth, it's a genuine coin flip.",
        "Both sides matching each other gold for gold.",
      ] });
    } else if (diff >= 4000) {
      out.push({ condition: "net_worth", subject: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
        "{lead} nose in front by {diff} in gold.",
        "A working advantage for {lead}, {diff} up on net worth.",
        "{lead} edging the economy, {diff} to the good.",
        "It's {lead} with the gold cushion now — {diff} clear.",
        "{lead} building something here, {diff} up on net worth.",
        "The economy tilts {lead}'s way, a {diff} lead.",
      ] });
    }
    if (prev) {
      const pl = leaderByNet(prev);
      if (pl.lead.id === lead.id && pl.diff - diff >= 2500) {
        out.push({ condition: "net_worth", subject: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff), closed: goldK(pl.diff - diff) }, defaults: [
          "{trail} clawing back — they've shaved {closed} off the deficit.",
          "The gap is closing; {trail} back within {diff}.",
          "{trail} chipping into the lead, {closed} of it gone already.",
          "Momentum with {trail} — the deficit's down to {diff}.",
          "{trail} refusing to fold, {closed} clawed back off the gold gap.",
        ] });
      }
      if (pl.lead.id !== lead.id && diff >= 1500) {
        out.push({ condition: "net_worth", subject: "net_worth", facts: { lead: lead.name, trail: trail.name, diff: goldK(diff) }, defaults: [
          "Lead has flipped — {lead} now ahead on gold.",
          "Momentum swing! {lead} have taken over the net worth lead.",
          "The gold lead changes hands — it's {lead} in front now.",
          "{lead} have turned it around and now hold the economy edge.",
          "Complete reversal on net worth — {lead} on top by {diff}.",
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
      out.push({ condition: "kills", subject: "kills", facts: { lead: lead.name, trail: trail.name, hi, lo, a, b }, defaults: [
        "{lead} bullying the scoreboard, {hi}–{lo} on kills.",
        "{lead} with a commanding {hi}–{lo} kill lead.",
        "{lead} winning every fight that matters — {hi}–{lo}.",
        "It's one-way traffic on the kill feed, {lead} up {hi}–{lo}.",
        "{lead} dictating the pace, {hi} kills to {lo}.",
        "The scoreboard says it all: {lead} {hi}, {trail} {lo}.",
      ] });
    } else if (hi + lo >= 6 && hi - lo <= 2) {
      out.push({ condition: "kills", subject: "kills", facts: { lead: lead.name, trail: trail.name, hi, lo, a, b }, defaults: [
        "Bloodbath and it's even — {hi}–{lo} on the kill count.",
        "Both teams trading everything, {a}–{b} in kills.",
        "A proper slugfest, blows landing both ways at {a}–{b}.",
        "Neither side backing down — {a}–{b} and every fight is a scrap.",
        "End to end stuff, the kills level at {hi}–{lo}.",
        "They are trading punches, {a}–{b} and nothing given easy.",
      ] });
    }
    if (prev) {
      const totalNow = a + b;
      const totalPrev = tk(prev, now.teamA.id) + tk(prev, now.teamB.id);
      const gained = totalNow - totalPrev;
      if (gained >= 3) {
        out.push({ condition: "kills", subject: "kills", facts: { lead: lead.name, trail: trail.name, count: gained, hi, lo }, defaults: [
          "Teamfight just erupted — {count} kills in a blink.",
          "A skirmish breaks out, {count} down in quick succession.",
          "It's kicked off! {count} taken in the scramble.",
          "Chaos in the fight — {count} kills traded already.",
          "The dam breaks: {count} go down at once.",
          "Big fight, big swing — {count} on the feed just like that.",
        ] });
      } else if (gained >= 1) {
        const scorer = tk(now, lead.id) - tk(prev, lead.id) > 0 ? lead : trail;
        out.push({ condition: "kills", subject: "kills", facts: { scorer: scorer.name, lead: lead.name, trail: trail.name, count: gained }, defaults: [
          "{scorer} pick up a kill to keep the pressure on.",
          "The next one goes to {scorer}.",
          "{scorer} find a pick and tilt the numbers.",
          "First blood of this exchange belongs to {scorer}.",
          "{scorer} catch one out — advantage pressed.",
          "A clean pickoff for {scorer}.",
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
        out.push({ condition: "tower", subject: `tower:${team.id}`, facts: { team: team.name, count: cur }, defaults: [
          "{team} crack another tower — up to {count} now.",
          "Structure falls; {team} take tower number {count}.",
          "{team} keep chipping the map, {count} towers down.",
          "Another one gone — {team} now on {count} towers.",
          "{team} pry open the map, {count} structures to their name.",
          "Tower down for {team}, that's {count} in the bank.",
          "{team} trade the fight for a tower — {count} total.",
        ] });
      }
    }
    const ta = objc(now, now.teamA.id, "tower");
    const tb = objc(now, now.teamB.id, "tower");
    if (Math.abs(ta - tb) >= 3) {
      const leader = ta > tb ? now.teamA : now.teamB;
      out.push({ condition: "tower", subject: "tower_lead", facts: { leader: leader.name, hi: Math.max(ta, tb), lo: Math.min(ta, tb) }, defaults: [
        "{leader} own the map — {hi} towers to {lo}.",
        "Territory is all {leader}: {hi} towers to {lo}.",
        "{leader} have the map choked, {hi}–{lo} on structures.",
        "Half the map belongs to {leader}, {hi} towers to {lo}.",
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
        out.push({ condition: "turtle", subject: "turtle", facts: { team: team.name }, defaults: [
          "{team} slam the Turtle for the gold and buff.",
          "Turtle goes to {team} — a tidy pickup.",
          "{team} secure the Turtle, gold for the whole squad.",
          "That's the Turtle for {team}, momentum and money.",
          "{team} bank the Turtle without a fuss.",
          "Easy gold for {team} off the back of that Turtle.",
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
        out.push({ condition: "lord", subject: "lord", facts: { team: team.name }, defaults: [
          "{team} secure the LORD — this could be the game-ender.",
          "Lord is down and it belongs to {team}. Massive.",
          "{team} take Lord and now they march.",
          "The Lord is {team}'s — the siege is coming.",
          "{team} slay the Lord; this is a match-defining call.",
          "Huge for {team} — Lord in the bag and pushing.",
          "{team} get the Lord and now the base is under threat.",
        ] });
      }
    }
    return out;
  },

  // ── player KDA: unkillable / carry / good game / shutdown ─────────────
  // Emits a line for MULTIPLE standout players (not just #1), each tagged with
  // that player's name as its subject — so the picker can rotate away from a
  // player it just spotlighted instead of parroting the same name every tick.
  // Every branch requires a real accomplishment (kills/assists/deaths past a
  // floor) so a lobby of 0/0/0 rows never gets a spurious "taking over" line.
  (ctx) => {
    const { now } = ctx;
    const out: Trigger[] = [];
    const byImpact = [...now.players].sort((a, b) => b.kills + b.assists - (a.kills + a.assists));
    for (const p of byImpact.slice(0, 2)) {
      const ka = p.kills + p.assists;
      const facts = { player: p.name, k: p.kills, d: p.deaths, a: p.assists, ka };
      if (p.kills >= 4 && p.deaths === 0) {
        out.push({ condition: "player_kda", subject: p.name, facts, defaults: [
          "{player} is unkillable — {k} kills and yet to fall.",
          "Nobody can touch {player}: {k}/{d}/{a}.",
          "{player} is on a different level, {k} kills without a death.",
          "A flawless game so far from {player} — {k}/{d}/{a}.",
          "{player} untouchable, {k} to their name and still standing.",
        ] });
      } else if (ka >= 8) {
        out.push({ condition: "player_kda", subject: p.name, facts, defaults: [
          "{player} is taking over — {k}/{d}/{a} on the board.",
          "{player} everywhere on the map, already {ka} takedowns involved.",
          "{player} carrying the load, {ka} kills and assists so far.",
          "This is the {player} show — {k}/{d}/{a}.",
          "{player} stamping their name on this game, {ka} involvements.",
        ] });
      } else if (ka >= 4) {
        out.push({ condition: "player_kda", subject: p.name, facts, defaults: [
          "{player} having a real say in this one — {k}/{d}/{a}.",
          "{player} racking up the involvement, {ka} kills and assists.",
          "{player} showing up in the fights, {k}/{d}/{a}.",
          "Good game building for {player}: {ka} takedowns involved.",
          "{player} making their presence felt, {k}/{d}/{a}.",
        ] });
      }
    }
    const feeder = [...now.players].sort((a, b) => b.deaths - a.deaths)[0];
    if (feeder && feeder.deaths >= 4 && feeder.deaths > feeder.kills + 1) {
      out.push({ condition: "player_kda", subject: feeder.name, facts: { player: feeder.name, k: feeder.kills, d: feeder.deaths, a: feeder.assists, ka: feeder.kills + feeder.assists }, defaults: [
        "Rough one for {player}, caught out {d} times now.",
        "{player} can't buy a break — down {d} deaths.",
        "The opposition are hunting {player}, {d} times already.",
        "{player} having a nightmare, {k}/{d}/{a} on the game.",
        "It's not falling for {player} — {d} deaths and counting.",
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
      out.push({ condition: "win_prob", subject: "win_prob", facts: { favored: favored.name, pct: favPct }, defaults: [
        "The model has {favored} firmly in front — {pct}% to close it out.",
        "{favored} in the driver's seat at {pct}% win chance.",
        "The numbers love {favored} here, {pct}% to win it.",
        "{favored} heavy favourites now — {pct}% on the model.",
        "It's {favored}'s to lose, the read sits at {pct}%.",
      ] });
    }
    if (prev) {
      const shift = now.winProbA - prev.winProbA;
      if (Math.abs(shift) >= 0.1) {
        const to = shift > 0 ? now.teamA : now.teamB;
        out.push({ condition: "win_prob", subject: "win_prob", facts: { to: to.name }, defaults: [
          "Momentum swinging toward {to} on the win-probability read.",
          "The needle moves for {to} — this is where games turn.",
          "{to} tilting the odds their way now.",
          "Big shift on the model, and it's {to} climbing.",
          "The win probability lurches toward {to}.",
        ] });
      }
    }
    return out;
  },

  // ── hero & player flavor ──────────────────────────────────────────────
  // Gated on the featured player actually having done something (kills+assists
  // ≥ 3) so it can't spotlight a hero on the strength of a 0/0/0 line, and
  // emits the top TWO impactful heroes so the picker can rotate subjects.
  (ctx) => {
    const { now } = ctx;
    const withHero = now.players.filter((p) => p.heroName && p.kills + p.assists >= 3);
    if (withHero.length === 0) return [];
    const ranked = [...withHero].sort((a, b) => b.kills + b.assists - (a.kills + a.assists));
    return ranked.slice(0, 2).map((star) => ({
      condition: "hero" as const,
      subject: star.name,
      facts: { player: star.name, hero: star.heroName as string },
      defaults: [
        "{hero} in the hands of {player} is a real problem right now.",
        "Watch the {hero} — {player} is finding all the angles.",
        "{player}'s {hero} looking like the pick of the draft.",
        "{player} has the {hero} humming — a menace in every fight.",
        "That {hero} pick is paying off for {player}.",
        "{player} making the {hero} look broken right now.",
      ],
    }));
  },

  // ── general pacing / hype (with an intense late-game section) ──────────
  // Past 18:00 the game is in high-stakes territory — one fight ends it — so
  // the phrasing turns up the tension instead of the neutral "late game" filler.
  (ctx) => {
    const { now } = ctx;
    const m = Math.floor(now.timerSeconds / 60);
    if (m < 5) {
      return [{ condition: "general", facts: {}, defaults: [
        "Still early doors — both sides settling into the farm.",
        "Opening exchanges, feeling each other out.",
        "Laning phase in full swing, last hits and level leads for now.",
        "Quiet start — everyone's heads down farming.",
        "Early game jostling for the jungle and lane priority.",
      ] }];
    } else if (m < 12) {
      return [{ condition: "general", facts: {}, defaults: [
        "Mid game and the map is opening up — objectives on the horizon.",
        "Rotations getting sharper as we hit the mid game.",
        "The game's stretching its legs now — expect the fights to start.",
        "Cores coming online, and the tempo is picking up.",
        "Mid game chess — positioning and vision for the next objective.",
      ] }];
    } else if (m < 18) {
      return [{ condition: "general", facts: {}, defaults: [
        "Deep into the late game — one fight decides it from here.",
        "Every pick matters now; there's no respawning your way out of a bad one.",
        "The stakes are climbing — full builds and long respawns.",
        "This is the business end; a single mistake could be terminal.",
        "Late game tension — both sides walking on eggshells around the map.",
      ] }];
    }
    return [{ condition: "general", facts: {}, defaults: [
      "We are into the danger zone past 18 minutes — respawns are long and one clean pick ends it.",
      "Every base race and Lord call is match point now — nerves of steel required.",
      "This is where legends are made — a single teamfight from here writes the result.",
      "Deep, deep late game — buybacks of momentum only; there's no farming your way back now.",
      "Sudden-death territory now — one thrown fight and it's over.",
      "Everything on a knife's edge past 18 — the next objective could end it.",
    ] }];
  },
];

export type CommentaryOptions = {
  rng?: Rng;
  templates?: CommentaryTemplate[];
  // Language for the built-in phrasings. "id" swaps each built-in line for its
  // Bahasa Indonesia equivalent (ID_TEMPLATES) before rendering; DB custom
  // templates render as authored regardless. Defaults to English.
  lang?: CommentaryLang;
  // Anti-repetition memory the caller threads through: the exact line texts most
  // recently posted, the subjects most recently spotlighted, and the conditions
  // most recently used. The picker drops exact repeats, then rotates away from
  // recent subjects AND recent conditions so the feed doesn't loop on one
  // player, one hero, one phrasing, or one KIND of line (e.g. win-prob) in a row.
  recent?: { texts?: string[]; subjects?: string[]; conditions?: CommentaryCondition[] };
};

// Build the full candidate set for the current context — built-in phrasings PLUS
// any enabled admin templates for a fired condition — respecting the enabled
// toggles. Used by tests and by weighted selection.
export function commentaryCandidates(ctx: CommentaryContext, opts: CommentaryOptions = {}): CommentaryLine[] {
  const templates = opts.templates ?? [];
  const lang = opts.lang ?? "en";
  const lines: CommentaryLine[] = [];
  for (const g of generators) {
    for (const trig of g(ctx)) {
      if (!ctx.enabled.has(trig.condition)) continue;
      for (const d of trig.defaults) {
        // In Bahasa Indonesia mode, swap the built-in line for its ID
        // equivalent (placeholders preserved) before rendering; fall back to
        // English if a line has no translation yet.
        const src = lang === "id" ? ID_TEMPLATES[d] ?? d : d;
        const t = renderTemplate(src, trig.facts);
        if (t) lines.push({ condition: trig.condition, text: t, source: "builtin", subject: trig.subject });
      }
      for (const tpl of templates) {
        if (!tpl.enabled || tpl.condition !== trig.condition) continue;
        // EN and ID DB libraries are independent — only render rows for the
        // active language (a row with no lang is treated as English).
        if ((tpl.lang ?? "en") !== lang) continue;
        const t = renderTemplate(tpl.template, trig.facts);
        if (t) lines.push({ condition: trig.condition, text: t, source: "custom", subject: trig.subject, templateId: tpl.id });
      }
    }
  }
  return lines;
}

// Pick ONE natural line for this sample, or null if nothing noteworthy is
// enabled/true. Event-driven lines (a fight, an objective, a swing) are
// preferred over ambient pacing filler so the feed reacts to the game. Anything
// whose exact text was just posted is dropped, and lines whose subject was just
// spotlighted are avoided unless they're all that's left — so the feed doesn't
// loop on one player, one hero, or one phrasing.
export function pickCommentary(ctx: CommentaryContext, opts: CommentaryOptions = {}): CommentaryLine | null {
  const rng = opts.rng ?? Math.random;
  const recentTexts = new Set(opts.recent?.texts ?? []);
  const recentSubjects = new Set(opts.recent?.subjects ?? []);
  const recentConditions = new Set(opts.recent?.conditions ?? []);
  const all = commentaryCandidates(ctx, opts);
  if (all.length === 0) return null;
  // Drop exact repeats of lines we just used (fall back to the full set only if
  // that would leave nothing).
  const notJustSaid = all.filter((l) => !recentTexts.has(l.text));
  const usable = notJustSaid.length > 0 ? notJustSaid : all;
  const eventDriven = usable.filter((l) => l.condition !== "general");
  let pool = eventDriven.length > 0 ? eventDriven : usable;
  // Prefer lines whose CONDITION wasn't just used — stops the feed running a
  // string of win-prob (or any one category) reads back to back when other
  // categories are also eligible. Only applied when it leaves something.
  const freshCondition = pool.filter((l) => !recentConditions.has(l.condition));
  if (freshCondition.length > 0) pool = freshCondition;
  // Then prefer lines whose subject wasn't just spotlighted.
  const freshSubject = pool.filter((l) => !l.subject || !recentSubjects.has(l.subject));
  if (freshSubject.length > 0) pool = freshSubject;
  return pick(rng, pool);
}

// Bilingual pick — chooses ONE line in the operator's language exactly as
// pickCommentary does, then produces the parallel text in the OTHER language
// for the SAME condition (and same spotlighted subject where possible). Lets the
// caller persist both an EN and an ID version of a moment so admin and public
// each render their own language independently (they don't have to match). If
// the other language has no candidate for that condition, it falls back to the
// primary text so a moment is never blank.
export function pickCommentaryBilingual(
  ctx: CommentaryContext,
  opts: CommentaryOptions = {}
): { condition: CommentaryCondition; subject?: string; templateId?: string; en: string; id: string } | null {
  const primaryLang: CommentaryLang = opts.lang ?? "en";
  const primary = pickCommentary(ctx, { ...opts, lang: primaryLang });
  if (!primary) return null;
  const otherLang: CommentaryLang = primaryLang === "id" ? "en" : "id";
  const rng = opts.rng ?? Math.random;
  // Candidates in the other language for the SAME fired condition.
  const otherAll = commentaryCandidates(ctx, { ...opts, lang: otherLang }).filter(
    (l) => l.condition === primary.condition
  );
  // Prefer one about the same subject (same player/hero/objective) so the two
  // languages describe the same event, not two different ones.
  const sameSubject = primary.subject ? otherAll.filter((l) => l.subject === primary.subject) : [];
  const otherPool = sameSubject.length > 0 ? sameSubject : otherAll;
  const otherText = otherPool.length > 0 ? pick(rng, otherPool).text : primary.text;
  return {
    condition: primary.condition,
    subject: primary.subject,
    templateId: primary.templateId,
    en: primaryLang === "en" ? primary.text : otherText,
    id: primaryLang === "id" ? primary.text : otherText,
  };
}

// A guaranteed win-probability sentence for the periodic "read" interjection the
// caller schedules on its own cadence (every few minutes), independent of the
// threshold-gated win_prob generator above. Always returns text, phrased to the
// current margin, with light RNG variety so back-to-back reads don't repeat.
export function winProbInterjection(s: CommentarySnapshot, rng: Rng = Math.random, lang: CommentaryLang = "en"): string {
  const p = s.winProbA;
  const aPct = Math.round(p * 100);
  const bPct = 100 - aPct;
  const favored = p >= 0.5 ? s.teamA : s.teamB;
  const favPct = Math.max(aPct, bPct);
  if (lang === "id") {
    // Same three margin bands, Bahasa Indonesia. Placeholders filled here so the
    // team names (data) stay original.
    const fill = (tpl: string) =>
      tpl
        .split("{teamA}").join(s.teamA.name)
        .split("{teamB}").join(s.teamB.name)
        .split("{favored}").join(favored.name)
        .split("{aPct}").join(String(aPct))
        .split("{bPct}").join(String(bPct))
        .split("{favPct}").join(String(favPct))
        .split("{rest}").join(String(100 - favPct));
    const band = favPct <= 56 ? ID_WINPROB.even : favPct >= 85 ? ID_WINPROB.heavy : ID_WINPROB.lean;
    return fill(pick(rng, band));
  }
  if (favPct <= 56) {
    return pick(rng, [
      `Win probability is a coin flip — ${s.teamA.name} ${aPct}%, ${s.teamB.name} ${bPct}%.`,
      `The model can't split them: ${aPct}% / ${bPct}%.`,
      `Dead even on the win-probability read, ${s.teamA.name} ${aPct}% to ${s.teamB.name} ${bPct}%.`,
      `Too close to call — ${aPct}% versus ${bPct}% on the model.`,
      `Nothing between these two: ${s.teamA.name} ${aPct}%, ${s.teamB.name} ${bPct}%.`,
      `The odds are a dead heat right now, ${aPct}% each way barely.`,
    ]);
  }
  if (favPct >= 85) {
    return pick(rng, [
      `${favored.name} heavily favoured now — ${favPct}% to take it.`,
      `The needle's pinned to ${favored.name} at ${favPct}%.`,
      `${favored.name} in commanding shape, ${favPct}% on the model.`,
      `It's ${favored.name}'s to lose — ${favPct}% on the win-probability read.`,
      `The model has all but called it: ${favored.name} ${favPct}%.`,
      `${favored.name} closing in on this one, ${favPct}% and climbing.`,
    ]);
  }
  return pick(rng, [
    `Win probability leans ${favored.name} at ${favPct}%.`,
    `${favored.name} the favourites for now, ${favPct}% to close it.`,
    `Edge to ${favored.name} — ${favPct}% on the win-probability read.`,
    `${favored.name} nudging ahead on the model, ${favPct}%.`,
    `The odds tip ${favored.name}'s way, ${favPct}% to ${100 - favPct}%.`,
    `Slight lean to ${favored.name} here, ${favPct}% on the read.`,
  ]);
}
