// Feature flags for the Game-State Reconstruction Engine rollout (spec §40).
// ---------------------------------------------------------------------------
// All flags default to SAFE behavior in production: the reconstruction engine
// ships dark and the existing legacy path stays authoritative until shadow-mode
// comparison (spec §39) builds confidence. A broken reconstruction subsystem
// can be disabled with a single env var without reverting the deployment.
//
// This is the rollback path for v4.0: with every flag off (the default), the
// site behaves exactly as it did before this engine was added. The confirmed-
// state public API still works — it simply derives the contract from the
// existing DB tables rather than from a reconstruction snapshot.

function boolEnv(name: string, def = false): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on";
}

export const flags = {
  // Persist observations/events and materialize a reconstruction snapshot in
  // the new tables. OFF by default — requires the additive migration to be
  // applied first (supabase/migrations/reconstruction_engine.sql).
  get reconstructionPersistence() {
    return boolEnv("RECONSTRUCTION_PERSISTENCE");
  },
  // Run the engine alongside the legacy path and log divergences (spec §39).
  // Safe to enable before switching public reads; changes no public output.
  get reconstructionShadowMode() {
    return boolEnv("RECONSTRUCTION_SHADOW_MODE");
  },
  // Serve the public confirmed-state API from the reconstruction snapshot
  // instead of deriving it from legacy tables. Enabled by owner decision after
  // live shadow review (net worth / timer / team-kills-from-player-kills judged
  // more accurate than legacy). The public API falls back to legacy per game
  // whenever a reconstruction snapshot is absent, so this is safe to leave on.
  // ROLLBACK: set RECONSTRUCTION_PUBLIC_READS=0 (or false/off) to revert to the
  // legacy-derived contract with a single env var, no redeploy of code.
  get reconstructionPublicReads() {
    return boolEnv("RECONSTRUCTION_PUBLIC_READS", true);
  },
  // Expose the admin State Health diagnostics route.
  get adminStateHealth() {
    return boolEnv("ADMIN_STATE_HEALTH", true); // read-only + admin-guarded → safe on
  },
  // AI Vision as a non-authoritative reconstruction observer (spec §25-27):
  // when on, the AI frame-analysis route ALSO records its detections as
  // append-only rows in game_observations — graded through the SAME
  // reconstruction validators + evidence model (spec §26/§30), tagged
  // source="vision". OFF by default. This never changes what the legacy write
  // path commits and never affects public reads — it only builds the evidence
  // trail the later hybrid-fusion phase reconciles against CV. ROLLBACK: unset
  // RECONSTRUCTION_AI_OBSERVER (or =0) — the observer step becomes a no-op.
  get reconstructionAiObserver() {
    return boolEnv("RECONSTRUCTION_AI_OBSERVER");
  },
} as const;

export type FeatureFlags = typeof flags;

// Client-side shadow toggle for the admin Hot Match capture loop. The
// server-side flags above are not readable in the browser (only NEXT_PUBLIC_*
// vars are inlined), so the live shadow adapter is gated by this instead:
// a NEXT_PUBLIC env var OR a per-browser localStorage override
// (`livevival:shadow` = "1"), so an admin can turn shadow mode on for their own
// session to test — without any deploy — and it is OFF for everyone by default.
// With it off, the capture loop's only added cost is populating a small local
// object per tick; no reconstruction runs and nothing changes.
export function clientShadowModeEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_RECONSTRUCTION_SHADOW_MODE === "1") return true;
  try {
    if (typeof window !== "undefined" && window.localStorage.getItem("livevival:shadow") === "1") return true;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts — treat as off.
  }
  return false;
}
