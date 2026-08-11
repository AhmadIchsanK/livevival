// REAL production telemetry pulled from the live Livevival Supabase
// (project oieootgmrryetsgvyaky) on 2026-08-11 via the Supabase MCP. These are
// not synthetic numbers — they are the exact rows the legacy Hot Match capture
// wrote for two finished games, used to validate the reconstruction engine
// against genuine OCR output and its real failure modes.
//
//   DIRTY = ONIC vs Team Falcons PH, match 444bcd8d, game e6d55ae8 (607s)
//           legacy team_a_kills_override=19, team_b_kills_override=73
//   CLEAN = Selangor Red Giants vs Aurora Gaming, match 9c5e0c10,
//           game 43ab7433 (753s), legacy 4-3
//
// Team/player ids are the real uuids (the user's own data, already in their DB).

export const DIRTY_TEAM_A = "10676f33-4b3b-4bae-9dab-494d7e9cfd45"; // ONIC
export const DIRTY_TEAM_B = "8153c3dc-9876-4f52-9652-11f4162f7c0d"; // Falcons

// Final legacy player_stats (dirty game). Note team B has 0 summed kills yet
// legacy team_b_kills_override = 73; and two ONIC players show 85/86 assists.
export const DIRTY_PLAYER_STATS = [
  { pid: "bafd00d0", team: DIRTY_TEAM_B, k: 0, d: 1, a: 0 },
  { pid: "8a929d96", team: DIRTY_TEAM_B, k: 0, d: 2, a: 0 },
  { pid: "41007702", team: DIRTY_TEAM_B, k: 0, d: 2, a: 0 },
  { pid: "7998b015", team: DIRTY_TEAM_A, k: 2, d: 0, a: 86 },
  { pid: "e3809e07", team: DIRTY_TEAM_B, k: 0, d: 1, a: 0 },
  { pid: "88215ff6", team: DIRTY_TEAM_B, k: 0, d: 1, a: 0 },
  { pid: "6226a949", team: DIRTY_TEAM_A, k: 6, d: 0, a: 5 },
  { pid: "1cfbfc72", team: DIRTY_TEAM_A, k: 0, d: 1, a: 10 },
  { pid: "c395994d", team: DIRTY_TEAM_A, k: 2, d: 0, a: 85 },
  { pid: "27ae154d", team: DIRTY_TEAM_A, k: 7, d: 0, a: 3 },
];

export const DIRTY_TEAM_KILLS_OVERRIDE = { [DIRTY_TEAM_A]: 19, [DIRTY_TEAM_B]: 73 };

// Real objectives (dirty game): 1 turtle, then THREE lords all stamped minute
// 10 — impossible (lord respawns 3 min after a kill).
export const DIRTY_OBJECTIVES = [
  { team: DIRTY_TEAM_A, type: "turtle", m: 5 },
  { team: DIRTY_TEAM_B, type: "lord", m: 10 },
  { team: DIRTY_TEAM_B, type: "lord", m: 10 },
  { team: DIRTY_TEAM_B, type: "lord", m: 10 },
];

// Real net_worth_snapshots (dirty game), team A gold in stored insertion order.
// Contains decreases, digit-drop noise and spikes the legacy path stored raw.
export const DIRTY_NW_TEAM_A = [
  7000, 7000, 10400, 8400, 9700, 9600, 7400, 10100, 7800, 9000, 8600, 7600, 7000, 8800, 7300,
  7000, 9800, 10600, 12300, 10800, 12300, 10800, 10800, 12700, 10800, 10800, 18700, 16000, 13700,
  16800, 14200, 15700, 14200, 19300, 20500, 22400, 19800, 20600, 21600, 24000, 23000, 23200, 24200,
  25700, 26000, 22700, 22800, 24500, 23800, 25300, 30300, 31900, 26100, 26500, 27700, 32100, 26800,
  24500, 24500, 24500, 32200, 31300, 24500, 32500, 32300, 32500, 32500, 32500, 40000, 32500, 38300, 32500,
];
export const DIRTY_NW_TEAM_B = [
  600, 700, 10400, 8600, 10000, 7200, 7400, 10300, 7200, 15200, 15200, 7200, 600, 8300, 7200, 600,
  10000, 10800, 12800, 10000, 10000, 10000, 10000, 12600, 10000, 10000, 12800, 12800, 12800, 12800,
  15500, 12800, 12800, 12800, 15800, 15800, 15800, 15800, 15800, 18500, 15800, 15800, 18500, 18500,
  15800, 15800, 15800, 18500, 23800, 18500, 18500, 22500, 18500, 20300, 20800, 18500, 20500, 18500,
  18500, 20700, 23000, 18500, 24200, 18500, 18500, 23800, 23600, 24800, 26800, 25800, 25800, 18500,
];

// The legacy public page shows the LAST snapshot in this list for each team.
export const DIRTY_LEGACY_LATEST_NW = {
  [DIRTY_TEAM_A]: DIRTY_NW_TEAM_A[DIRTY_NW_TEAM_A.length - 1],
  [DIRTY_TEAM_B]: DIRTY_NW_TEAM_B[DIRTY_NW_TEAM_B.length - 1],
};

// Real net_worth_snapshots (clean game), team A gold, stored order. Also full of
// digit-drop noise (57, 10, 12, 1300, 101 ...) despite being the "clean" game.
export const CLEAN_NW_TEAM_A = [
  5400, 5600, 57, 5800, 6200, 6400, 6600, 6800, 7300, 7800, 8200, 8600, 8700, 91, 9200, 9600, 9800,
  10, 101, 10400, 10900, 1300, 1400, 12, 12, 12200, 12600, 127, 13200, 13500, 13700, 141, 14300,
  14500, 147, 15, 15200, 154, 157, 15800, 161, 16300, 173, 17500, 17500, 177, 18100, 18400,
];
