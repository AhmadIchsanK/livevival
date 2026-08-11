// Objective validators (spec §7, §8, §9, §16, §17) — explicit state machines
// for Turtle, Lord, Turret and Base, constrained by the game timer.
// ---------------------------------------------------------------------------
// These decide whether an OCR-observed objective count increase is legal given
// the confirmed timer and objective history. They return the count the tick is
// allowed to advance to (clamped, not a hard drop) so a correct-but-partial
// read still lands. Manual admin edits bypass these entirely (handled upstream).
import type { ValidationResult } from "../types.ts";

export const OBJECTIVE_TOLERANCE_SECONDS = 5;

// ── Turtle (spec §7) ────────────────────────────────────────────────────────
// First spawn exactly 02:00. Respawns every 2 minutes after the previous is
// slain. No new turtle once the active one is killed after 06:00 (it becomes
// the early Lord). Maximum 4 per game. Shared across both teams (one turtle on
// the map), so the cap and timing are global, not per-team.
export type TurtleContext = {
  timerSeconds: number;
  turtleTotal: number; // confirmed turtles taken this game (both teams)
  lastTurtleKillSeconds: number | null; // when the previous turtle was slain
};

export function validateTurtle(
  target: number,
  current: number,
  ctx: TurtleContext
): ValidationResult<number> {
  if (target <= current) return { status: "confirmed", value: target, reason: "no increase" };
  if (ctx.timerSeconds < 120 - OBJECTIVE_TOLERANCE_SECONDS)
    return { status: "rejected", value: current, reason: "before first turtle spawn (~02:00)" };
  if (ctx.turtleTotal >= 4)
    return { status: "rejected", value: current, reason: "max 4 turtles per game" };
  // Latest possible turtle spawn is ~08:00 (06:00 cutoff + 2min respawn); by
  // 08:00-09:00 it is the early Lord. A turtle read past ~09:00 is impossible.
  if (ctx.timerSeconds > 540 + OBJECTIVE_TOLERANCE_SECONDS)
    return { status: "rejected", value: current, reason: "past turtle window (~09:00)" };
  if (ctx.lastTurtleKillSeconds != null) {
    if (ctx.timerSeconds < ctx.lastTurtleKillSeconds + 120 - OBJECTIVE_TOLERANCE_SECONDS)
      return { status: "rejected", value: current, reason: "before 2-min respawn interval" };
    // Cutoff: active turtle killed at/after 06:00 is the last one. >= because
    // a kill anywhere in 06:00-06:59 stores as minute 6 → 360s.
    if (ctx.lastTurtleKillSeconds >= 360)
      return { status: "rejected", value: current, reason: "cutoff: last turtle killed after 06:00" };
  }
  return { status: "confirmed", value: target, reason: "legal turtle" };
}

// ── Lord (spec §8) ──────────────────────────────────────────────────────────
// First Lord ~08:00. Respawns exactly 3 minutes after being slain. Shared.
export type LordContext = {
  timerSeconds: number;
  lastLordKillSeconds: number | null;
};

export function validateLord(
  target: number,
  current: number,
  ctx: LordContext
): ValidationResult<number> {
  if (target <= current) return { status: "confirmed", value: target, reason: "no increase" };
  if (ctx.timerSeconds < 480 - OBJECTIVE_TOLERANCE_SECONDS)
    return { status: "rejected", value: current, reason: "before first lord spawn (~08:00)" };
  if (ctx.lastLordKillSeconds != null) {
    if (ctx.timerSeconds < ctx.lastLordKillSeconds + 180 - OBJECTIVE_TOLERANCE_SECONDS)
      return { status: "rejected", value: current, reason: "before 3-min lord respawn" };
  }
  return { status: "confirmed", value: target, reason: "legal lord" };
}

// ── Turret (spec §9, §17) ───────────────────────────────────────────────────
// 9 lane turrets per team (top/mid/bot × T1/T2/T3). Destroyed count is
// monotonic. At most ~3 can plausibly fall near-simultaneously (one per lane),
// so a single-tick jump beyond that is a misread. Count caps at 9.
export const MAX_TURRET_JUMP_PER_TICK = 3;
export const TURRETS_PER_TEAM = 9;

export function validateTurret(
  target: number,
  current: number
): ValidationResult<number> {
  if (target <= current) return { status: "confirmed", value: target, reason: "no increase" };
  const capped = Math.min(target, TURRETS_PER_TEAM);
  if (capped - current > MAX_TURRET_JUMP_PER_TICK) {
    return {
      status: "candidate",
      value: current + MAX_TURRET_JUMP_PER_TICK,
      reason: `turret jump +${capped - current} exceeds ${MAX_TURRET_JUMP_PER_TICK}/tick`,
    };
  }
  return { status: "confirmed", value: capped, reason: "legal turret" };
}

// Physical turret model (spec §17): top/mid/bot × T1/T2/T3 + base. Keys are
// "lane-tier" e.g. "top-1". Provided so future recognition can identify the
// exact turret; the aggregate count is a derived field.
export const TURRET_LANES = ["top", "mid", "bot"] as const;
export const TURRET_TIERS = [1, 2, 3] as const;

export function turretKey(lane: (typeof TURRET_LANES)[number], tier: (typeof TURRET_TIERS)[number]): string {
  return `${lane}-${tier}`;
}

export function allTurretKeys(): string[] {
  const keys: string[] = [];
  for (const lane of TURRET_LANES) for (const tier of TURRET_TIERS) keys.push(turretKey(lane, tier));
  return keys;
}
