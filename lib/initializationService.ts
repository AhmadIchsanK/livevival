// Initialization service: runs on app startup to warm caches and prepare data
// Called from middleware or layout initialization

import { prefetchCommonQueries } from "@/lib/queryCache";
import { cacheWarmer, swr } from "@/lib/cachingStrategies";

let initialized = false;
let initPromise: Promise<void> | null = null;

export async function initializeApp(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = performInitialization();
  return initPromise;
}

async function performInitialization(): Promise<void> {
  console.log("[Initialization] Starting app initialization...");
  const startTime = Date.now();

  try {
    // Phase 1: Prefetch common queries (Phase 2 feature)
    console.log("[Initialization] Prefetching common queries...");
    await prefetchCommonQueries();

    // Phase 2: Warm cache with critical data (Phase 4 feature)
    console.log("[Initialization] Warming cache with critical data...");
    await cacheWarmer.warmCache();

    // Phase 3: Initialize SWR cache
    console.log("[Initialization] Initializing SWR cache...");
    // SWR is ready, no special initialization needed

    const duration = Date.now() - startTime;
    console.log(`[Initialization] App initialization completed in ${duration}ms`);
    initialized = true;
  } catch (error) {
    console.error("[Initialization] Failed:", error);
    // Don't crash the app if initialization fails
    // Queries will fall back to direct database access
    initialized = true;
  }
}

export function isInitialized(): boolean {
  return initialized;
}

export async function reinitialize(): Promise<void> {
  initialized = false;
  initPromise = null;
  await initializeApp();
}
