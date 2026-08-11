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
  // instead of deriving it from legacy tables. Only flip after shadow-mode
  // acceptance. When off, the API still works (legacy-derived contract).
  get reconstructionPublicReads() {
    return boolEnv("RECONSTRUCTION_PUBLIC_READS");
  },
  // Expose the admin State Health diagnostics route.
  get adminStateHealth() {
    return boolEnv("ADMIN_STATE_HEALTH", true); // read-only + admin-guarded → safe on
  },
} as const;

export type FeatureFlags = typeof flags;
