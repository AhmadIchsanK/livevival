// Post-game / live match analytics — pure, dependency-free so it can be unit
// tested and shared by the public match page and the admin console.
//   - net-worth-difference series over the game timer (for the chart)
//   - win-probability from gold + kill lead
//   - role-weighted MVP / SVP selection
// Nothing here reads OCR or the DB; callers pass already-loaded values.

// ── Net worth difference over time ─────────────────────────────────────────
export type NetWorthPoint = { minute_mark: number; team_a_gold: number; team_b_gold: number };
export type NetWorthDiffPoint = { minute: number; teamA: number; teamB: number; diff: number };

// One point per distinct minute (last reading of each minute wins, since a
// minute can hold several OCR ticks), sorted ascending. `diff` is A − B gold.
export function netWorthDiffSeries(points: NetWorthPoint[]): NetWorthDiffPoint[] {
  const byMinute = new Map<number, NetWorthPoint>();
  for (const p of [...points].sort((a, b) => a.minute_mark - b.minute_mark)) {
    byMinute.set(p.minute_mark, p); // later reading of the same minute overwrites
  }
  return Array.from(byMinute.values())
    .sort((a, b) => a.minute_mark - b.minute_mark)
    .map((p) => ({ minute: p.minute_mark, teamA: p.team_a_gold, teamB: p.team_b_gold, diff: p.team_a_gold - p.team_b_gold }));
}

// ── Win probability ─────────────────────────────────────────────────────────
// A transparent logistic model on the two signals we actually have: gold lead
// and kill lead (both from Team A's perspective). Deliberately simple and
// clearly-labeled — a lean indicator, not a trained model. Returns Team A's
// win probability in [0.02, 0.98] (never a false 0/100%).
export function winProbabilityTeamA(args: {
  teamAGold: number;
  teamBGold: number;
  teamAKills: number;
  teamBKills: number;
}): number {
  const goldDiff = args.teamAGold - args.teamBGold;
  const killDiff = args.teamAKills - args.teamBKills;
  // ~10k gold lead ≈ strong advantage; each kill of lead adds a little.
  const z = goldDiff / 8000 + killDiff / 8;
  const p = 1 / (1 + Math.exp(-z));
  return Math.max(0.02, Math.min(0.98, p));
}

// ── Role-weighted MVP / SVP ─────────────────────────────────────────────────
// "Different role, different calculation, should be fair": each role scores by
// how that role actually contributes, so a roamer who never last-hits a kill
// can still win on assists/participation, and a gold laner isn't over-rewarded
// just for farming kills. Score = role-weighted (k,a,d) + team fight
// participation share + a small hype-kill (Savage/Maniac) bonus.
export type RoleWeights = { kill: number; assist: number; death: number };

export function roleWeights(role: string | null | undefined): RoleWeights {
  switch ((role ?? "").toLowerCase()) {
    case "gold laner":
      return { kill: 2.0, assist: 0.8, death: 0.7 };
    case "jungler":
      return { kill: 1.8, assist: 1.0, death: 0.7 };
    case "mid laner":
      return { kill: 1.6, assist: 1.2, death: 0.6 };
    case "exp laner":
      return { kill: 1.4, assist: 1.1, death: 0.6 };
    case "roamer":
      return { kill: 1.0, assist: 1.8, death: 0.4 }; // assists are a roamer's currency; they die more
    default:
      return { kill: 1.5, assist: 1.2, death: 0.6 };
  }
}

export type MvpInput = {
  id: string;
  teamId: string | null;
  role: string | null;
  kills: number;
  deaths: number;
  assists: number;
  hypeKill?: boolean; // credited a Savage/Maniac
};

export type MvpScore = { id: string; teamId: string | null; score: number };
export type MvpSvpResult = { mvpId: string | null; svpId: string | null; scores: MvpScore[] };

export function scorePlayer(p: MvpInput, teamKillAssistTotal: number): number {
  const w = roleWeights(p.role);
  const base = p.kills * w.kill + p.assists * w.assist - p.deaths * w.death;
  const participation = teamKillAssistTotal > 0 ? ((p.kills + p.assists) / teamKillAssistTotal) * 10 : 0;
  return base + participation + (p.hypeKill ? 5 : 0);
}

// MVP = highest score overall. SVP = highest score among players NOT on the
// MVP's team (the standout on the other side — a positive "silver MVP", not a
// "worst player" callout). Returns nulls when there isn't enough data.
export function computeMvpSvp(players: MvpInput[]): MvpSvpResult {
  if (players.length === 0) return { mvpId: null, svpId: null, scores: [] };
  const teamTotal = new Map<string | null, number>();
  for (const p of players) {
    teamTotal.set(p.teamId, (teamTotal.get(p.teamId) ?? 0) + p.kills + p.assists);
  }
  const scores: MvpScore[] = players.map((p) => ({
    id: p.id,
    teamId: p.teamId,
    score: scorePlayer(p, teamTotal.get(p.teamId) ?? 0),
  }));
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const mvp = sorted[0] ?? null;
  const svp = sorted.find((s) => mvp && s.teamId !== mvp.teamId) ?? null;
  return { mvpId: mvp?.id ?? null, svpId: svp?.id ?? null, scores };
}
