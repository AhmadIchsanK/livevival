// Auto-commentary engine — turns the live game state (and how it changed since
// the last sample) into natural, caster-style one-liners for the Moment list.
// Pure and deterministic given an RNG, so it is unit-tested and reused by the
// admin capture loop, which fires it on a randomized ~1-2 minute cadence.
//
// It is template-driven for now (a growing library, not hand-written per game),
// with several phrasings per condition and weighted-random selection so the
// feed reads like a human filling airtime rather than a state dump. Each line
// is gated by a condition category the admin can toggle (net worth, kills,
// tower/turtle/lord objectives, player KDA, win probability, hero flavor).

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

export type CommentaryLine = { text: string; condition: CommentaryCondition };

export type CommentaryContext = {
  now: CommentarySnapshot;
  prev: CommentarySnapshot | null;
  enabled: Set<CommentaryCondition>;
};

type Rng = () => number; // [0,1)

function pick<T>(rng: Rng, arr: T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}
function nw(s: CommentarySnapshot, teamId: string): number {
  return s.netWorth[teamId] ?? 0;
}
function tk(s: CommentarySnapshot, teamId: string): number {
  return s.teamKills[teamId] ?? 0;
}
function obj(s: CommentarySnapshot, teamId: string, k: "turtle" | "lord" | "tower"): number {
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

// One generator per condition kind. Each returns candidate lines (0+), already
// phrased; the caller filters by enabled condition and picks one at random.
type Generator = (ctx: CommentaryContext, rng: Rng) => CommentaryLine[];

const generators: Generator[] = [
  // ── net worth: dominating / close / comeback ──────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const { lead, trail, diff } = leaderByNet(now);
    const out: CommentaryLine[] = [];
    if (diff >= 10000) {
      out.push({ condition: "net_worth", text: pick(rng, [
        `${lead.name} are running away with this — a ${goldK(diff)} gold lead.`,
        `It's turning into a stranglehold; ${lead.name} up ${goldK(diff)} in net worth.`,
        `${lead.name} in complete control of the gold, ahead by ${goldK(diff)}.`,
      ]) });
    } else if (diff <= 2000) {
      out.push({ condition: "net_worth", text: pick(rng, [
        `Dead even on gold — less than ${goldK(Math.max(diff, 500))} between them.`,
        `Anyone's game here, the net worth is razor thin.`,
        `Neck and neck; neither side can find a gold cushion.`,
      ]) });
    } else if (diff >= 4000) {
      out.push({ condition: "net_worth", text: pick(rng, [
        `${lead.name} nose in front by ${goldK(diff)} in gold.`,
        `A working advantage for ${lead.name}, ${goldK(diff)} up on net worth.`,
      ]) });
    }
    // comeback: trailing team closed the gap since last sample
    if (prev) {
      const prevLeader = leaderByNet(prev);
      if (prevLeader.lead.id === lead.id && prevLeader.diff - diff >= 2500) {
        out.push({ condition: "net_worth", text: pick(rng, [
          `${trail.name} clawing back — they've shaved ${goldK(prevLeader.diff - diff)} off the deficit.`,
          `The gap is closing; ${trail.name} back within ${goldK(diff)}.`,
        ]) });
      }
      if (prevLeader.lead.id !== lead.id && diff >= 1500) {
        out.push({ condition: "net_worth", text: pick(rng, [
          `Lead has flipped — ${lead.name} now ahead on gold.`,
          `Momentum swing! ${lead.name} have taken over the net worth lead.`,
        ]) });
      }
    }
    return out;
  },

  // ── team kills: leads and fights ──────────────────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const a = tk(now, now.teamA.id);
    const b = tk(now, now.teamB.id);
    const out: CommentaryLine[] = [];
    const [lead, trail, hi, lo] = a >= b ? [now.teamA, now.teamB, a, b] : [now.teamB, now.teamA, b, a];
    if (hi - lo >= 6) {
      out.push({ condition: "kills", text: pick(rng, [
        `${lead.name} bullying the scoreboard, ${hi}–${lo} on kills.`,
        `${lead.name} with a commanding ${hi}–${lo} kill lead.`,
      ]) });
    } else if (hi + lo >= 6 && hi - lo <= 2) {
      out.push({ condition: "kills", text: pick(rng, [
        `Bloodbath and it's even — ${hi}–${lo} on the kill count.`,
        `Both teams trading everything, ${a}–${b} in kills.`,
      ]) });
    }
    if (prev) {
      const totalNow = a + b;
      const totalPrev = tk(prev, now.teamA.id) + tk(prev, now.teamB.id);
      if (totalNow - totalPrev >= 3) {
        out.push({ condition: "kills", text: pick(rng, [
          `Teamfight just erupted — ${totalNow - totalPrev} kills in a blink.`,
          `A skirmish breaks out, ${totalNow - totalPrev} down in quick succession.`,
        ]) });
      } else if (totalNow - totalPrev >= 1) {
        const scorer = tk(now, lead.id) - tk(prev, lead.id) > 0 ? lead : trail;
        out.push({ condition: "kills", text: pick(rng, [
          `${scorer.name} pick up a kill to keep the pressure on.`,
          `First blood of this exchange goes to ${scorer.name}.`,
        ]) });
      }
    }
    return out;
  },

  // ── objectives: tower ─────────────────────────────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const out: CommentaryLine[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = obj(now, team.id, "tower");
      const was = prev ? obj(prev, team.id, "tower") : cur;
      if (prev && cur > was) {
        out.push({ condition: "tower", text: pick(rng, [
          `${team.name} crack another tower — up to ${cur} now.`,
          `Structure falls; ${team.name} take tower number ${cur}.`,
          `${team.name} keep chipping the map, ${cur} towers down.`,
        ]) });
      }
    }
    const ta = obj(now, now.teamA.id, "tower");
    const tb = obj(now, now.teamB.id, "tower");
    if (Math.abs(ta - tb) >= 3) {
      const l = ta > tb ? now.teamA : now.teamB;
      out.push({ condition: "tower", text: pick(rng, [
        `${l.name} own the map — ${Math.max(ta, tb)} towers to ${Math.min(ta, tb)}.`,
      ]) });
    }
    return out;
  },

  // ── objectives: turtle ────────────────────────────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const out: CommentaryLine[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = obj(now, team.id, "turtle");
      const was = prev ? obj(prev, team.id, "turtle") : cur;
      if (prev && cur > was) {
        out.push({ condition: "turtle", text: pick(rng, [
          `${team.name} slam the Turtle for the gold and buff.`,
          `Turtle goes to ${team.name} — a tidy pickup.`,
        ]) });
      }
    }
    return out;
  },

  // ── objectives: lord ──────────────────────────────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const out: CommentaryLine[] = [];
    for (const team of [now.teamA, now.teamB]) {
      const cur = obj(now, team.id, "lord");
      const was = prev ? obj(prev, team.id, "lord") : cur;
      if (prev && cur > was) {
        out.push({ condition: "lord", text: pick(rng, [
          `${team.name} secure the LORD — this could be the game-ender.`,
          `Lord is down and it belongs to ${team.name}. Massive.`,
          `${team.name} take Lord and now they march.`,
        ]) });
      }
    }
    return out;
  },

  // ── player KDA: unkillable / carry / shutdown ─────────────────────────
  (ctx, rng) => {
    const { now } = ctx;
    const out: CommentaryLine[] = [];
    const sorted = [...now.players].sort((a, b) => b.kills + b.assists - (a.kills + a.assists));
    const star = sorted[0];
    if (star && star.kills >= 4 && star.deaths === 0) {
      out.push({ condition: "player_kda", text: pick(rng, [
        `${star.name} is unkillable — ${star.kills} kills and yet to fall.`,
        `Nobody can touch ${star.name}: ${star.kills}/${star.deaths}/${star.assists}.`,
      ]) });
    } else if (star && star.kills + star.assists >= 8) {
      out.push({ condition: "player_kda", text: pick(rng, [
        `${star.name} is taking over — ${star.kills}/${star.deaths}/${star.assists} on the board.`,
        `${star.name} everywhere on the map, already ${star.kills + star.assists} takedowns involved.`,
      ]) });
    }
    const feeder = [...now.players].sort((a, b) => b.deaths - a.deaths)[0];
    if (feeder && feeder.deaths >= 4 && feeder.deaths > feeder.kills + 1) {
      out.push({ condition: "player_kda", text: pick(rng, [
        `Rough one for ${feeder.name}, caught out ${feeder.deaths} times now.`,
        `${feeder.name} can't buy a break — down ${feeder.deaths} deaths.`,
      ]) });
    }
    return out;
  },

  // ── win probability / momentum ────────────────────────────────────────
  (ctx, rng) => {
    const { now, prev } = ctx;
    const out: CommentaryLine[] = [];
    const p = now.winProbA;
    const favored = p >= 0.5 ? now.teamA : now.teamB;
    const favPct = Math.round((p >= 0.5 ? p : 1 - p) * 100);
    if (favPct >= 85) {
      out.push({ condition: "win_prob", text: pick(rng, [
        `The model has ${favored.name} firmly in front — ${favPct}% to close it out.`,
        `${favored.name} in the driver's seat at ${favPct}% win chance.`,
      ]) });
    }
    if (prev) {
      const shift = now.winProbA - prev.winProbA;
      if (Math.abs(shift) >= 0.1) {
        const to = shift > 0 ? now.teamA : now.teamB;
        out.push({ condition: "win_prob", text: pick(rng, [
          `Momentum swinging toward ${to.name} on the win-probability read.`,
          `The needle moves for ${to.name} — this is where games turn.`,
        ]) });
      }
    }
    return out;
  },

  // ── hero & player flavor ──────────────────────────────────────────────
  (ctx, rng) => {
    const { now } = ctx;
    const withHero = now.players.filter((p) => p.heroName);
    if (withHero.length === 0) return [];
    const star = [...withHero].sort((a, b) => b.kills + b.assists - (a.kills + a.assists))[0];
    return [{ condition: "hero", text: pick(rng, [
      `${star.heroName} in the hands of ${star.name} is a real problem right now.`,
      `Watch the ${star.heroName} — ${star.name} is finding all the angles.`,
      `${star.name}'s ${star.heroName} looking like the pick of the draft.`,
    ]) }];
  },

  // ── general pacing / hype ─────────────────────────────────────────────
  (ctx, rng) => {
    const { now } = ctx;
    const m = Math.floor(now.timerSeconds / 60);
    const out: CommentaryLine[] = [];
    if (m < 5) {
      out.push({ condition: "general", text: pick(rng, [
        `Still early doors — both sides settling into the farm.`,
        `Opening exchanges, feeling each other out.`,
      ]) });
    } else if (m < 12) {
      out.push({ condition: "general", text: pick(rng, [
        `Mid game and the map is opening up — objectives on the horizon.`,
        `Rotations getting sharper as we hit the mid game.`,
      ]) });
    } else {
      out.push({ condition: "general", text: pick(rng, [
        `Deep into the late game — one fight decides it from here.`,
        `Every pick matters now; there's no respawning your way out of a bad one.`,
      ]) });
    }
    return out;
  },
];

// Build the full candidate set for the current context (respecting the enabled
// condition toggles), for tests and for weighted selection.
export function commentaryCandidates(ctx: CommentaryContext, rng: Rng = Math.random): CommentaryLine[] {
  const lines: CommentaryLine[] = [];
  for (const g of generators) {
    for (const line of g(ctx, rng)) {
      if (ctx.enabled.has(line.condition)) lines.push(line);
    }
  }
  return lines;
}

// Pick ONE natural line for this sample, or null if nothing noteworthy is
// enabled/true. Event-driven lines (a fight, an objective, a swing) are
// preferred over ambient pacing filler so the feed reacts to the game.
export function pickCommentary(ctx: CommentaryContext, rng: Rng = Math.random): CommentaryLine | null {
  const all = commentaryCandidates(ctx, rng);
  if (all.length === 0) return null;
  const eventDriven = all.filter((l) => l.condition !== "general");
  const pool = eventDriven.length > 0 ? eventDriven : all;
  return pick(rng, pool);
}
