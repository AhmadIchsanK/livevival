// Advanced caching strategies for Phase 4
// Cache warming, predictive loading, stale-while-revalidate patterns

import { createClient } from "@supabase/supabase-js";

interface CacheWarmConfig {
  enabled: boolean;
  interval: number; // milliseconds
  priority: "critical" | "normal" | "low";
}

interface PrefetchRule {
  trigger: "on_init" | "on_state_change" | "on_schedule";
  dataKey: string;
  priority: "high" | "normal" | "low";
  staleAfter: number; // seconds
}

// Stale-While-Revalidate strategy: serve cached data while updating in background
export class StaleWhileRevalidateCache {
  private cache = new Map<string, { data: unknown; timestamp: number }>();
  private updating = new Set<string>();

  async get<T>(
    key: string,
    staleAfterMs: number,
    fetchFn: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key);

    // Return fresh data if available
    if (cached && now - cached.timestamp < staleAfterMs) {
      console.log(`[SWR] Fresh hit: ${key}`);
      return cached.data as T;
    }

    // Return stale data while revalidating in background
    if (cached && !this.updating.has(key)) {
      console.log(`[SWR] Stale hit, revalidating: ${key}`);
      this.revalidateInBackground(key, fetchFn);
      return cached.data as T;
    }

    // No cache, fetch fresh
    console.log(`[SWR] Cache miss, fetching: ${key}`);
    const fresh = await fetchFn();
    this.cache.set(key, { data: fresh, timestamp: now });
    return fresh;
  }

  private async revalidateInBackground<T>(
    key: string,
    fetchFn: () => Promise<T>
  ): Promise<void> {
    if (this.updating.has(key)) return;

    this.updating.add(key);
    try {
      const fresh = await fetchFn();
      this.cache.set(key, { data: fresh, timestamp: Date.now() });
      console.log(`[SWR] Revalidated: ${key}`);
    } catch (error) {
      console.error(`[SWR] Revalidation failed for ${key}:`, error);
    } finally {
      this.updating.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// Cache warming service: pre-load common data on startup or schedule
export class CacheWarmer {
  private rules: PrefetchRule[] = [];
  private supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  constructor() {
    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    // Critical: Load immediately on init
    this.rules.push({
      trigger: "on_init",
      dataKey: "tournaments",
      priority: "high",
      staleAfter: 3600, // 1 hour
    });

    this.rules.push({
      trigger: "on_init",
      dataKey: "matches:live",
      priority: "high",
      staleAfter: 300, // 5 minutes
    });

    // Normal: Load on schedule
    this.rules.push({
      trigger: "on_schedule",
      dataKey: "matches:upcoming",
      priority: "normal",
      staleAfter: 900, // 15 minutes
    });

    // Predictive: Load based on match lifecycle
    this.rules.push({
      trigger: "on_state_change",
      dataKey: "matches:by_state",
      priority: "normal",
      staleAfter: 600, // 10 minutes
    });
  }

  async warmCache(): Promise<void> {
    console.log("[CacheWarmer] Starting cache warming...");

    const initRules = this.rules.filter((r) => r.trigger === "on_init");

    for (const rule of initRules) {
      await this.loadData(rule.dataKey);
    }

    console.log("[CacheWarmer] Cache warming complete");
  }

  private async loadData(key: string): Promise<unknown> {
    try {
      switch (key) {
        case "tournaments":
          const { data: tournaments } = await this.supabase
            .from("tournaments")
            .select("*")
            .limit(100);
          console.log(
            `[CacheWarmer] Loaded ${tournaments?.length || 0} tournaments`
          );
          return tournaments;

        case "matches:live":
          const { data: liveMatches } = await this.supabase
            .from("matches")
            .select("*")
            .eq("status", "live")
            .limit(50);
          console.log(
            `[CacheWarmer] Loaded ${liveMatches?.length || 0} live matches`
          );
          return liveMatches;

        case "matches:upcoming":
          const now = new Date();
          const weekFromNow = new Date(
            now.getTime() + 7 * 24 * 60 * 60 * 1000
          );
          const { data: upcoming } = await this.supabase
            .from("matches")
            .select("*")
            .eq("status", "scheduled")
            .gte("scheduled_at", now.toISOString())
            .lte("scheduled_at", weekFromNow.toISOString())
            .order("scheduled_at", { ascending: true })
            .limit(200);
          console.log(
            `[CacheWarmer] Loaded ${upcoming?.length || 0} upcoming matches`
          );
          return upcoming;

        case "matches:by_state":
          const { data: allMatches } = await this.supabase
            .from("matches")
            .select("*, state:status")
            .limit(500);
          console.log(
            `[CacheWarmer] Loaded ${allMatches?.length || 0} matches by state`
          );
          return allMatches;

        default:
          console.warn(`[CacheWarmer] Unknown data key: ${key}`);
          return null;
      }
    } catch (error) {
      console.error(`[CacheWarmer] Failed to load ${key}:`, error);
      return null;
    }
  }

  addRule(rule: PrefetchRule): void {
    this.rules.push(rule);
  }

  removeRule(dataKey: string): void {
    this.rules = this.rules.filter((r) => r.dataKey !== dataKey);
  }

  getRules(): PrefetchRule[] {
    return [...this.rules];
  }
}

// Predictive loader: pre-fetch data based on user behavior or match state
export class PredictiveLoader {
  private matchStateTransitions: Record<string, string[]> = {
    MATCH_NOT_STARTED: ["DRAFT_STARTED", "GAME_STARTED"],
    DRAFT_STARTED: ["DRAFT_COMPLETE", "GAME_STARTED"],
    DRAFT_COMPLETE: ["GAME_STARTED"],
    GAME_STARTED: ["TECHNICAL_PAUSE", "GAME_FINISHED"],
    TECHNICAL_PAUSE: ["GAME_STARTED", "GAME_FINISHED"],
    GAME_FINISHED: ["MATCH_NOT_STARTED", "GAME_STARTED"], // Next game or next series
    SERIES_FINISHED: ["MATCH_NOT_STARTED"],
  };

  // Predict next state and prefetch related data
  async prefetchForNextState(
    currentState: string,
    supabase: ReturnType<typeof createClient>
  ): Promise<void> {
    const nextStates = this.matchStateTransitions[currentState] || [];

    console.log(
      `[PredictiveLoader] Prefetching data for potential states: ${nextStates.join(", ")}`
    );

    for (const state of nextStates) {
      try {
        switch (state) {
          case "DRAFT_STARTED":
            // Prefetch player rosters, draft history
            await supabase.from("players").select("*").limit(200);
            break;

          case "GAME_STARTED":
            // Prefetch game stats, live data structures
            await supabase.from("games").select("*").limit(50);
            break;

          case "GAME_FINISHED":
            // Prefetch final stats, screenshots
            await supabase
              .from("screenshots")
              .select("*")
              .limit(100);
            break;

          case "SERIES_FINISHED":
            // Prefetch next series if available
            await supabase
              .from("matches")
              .select("*")
              .eq("status", "scheduled")
              .order("scheduled_at", { ascending: true })
              .limit(10);
            break;
        }
      } catch (error) {
        console.debug(
          `[PredictiveLoader] Prefetch for ${state} had issue:`,
          error
        );
        // Silently continue, prefetching is low priority
      }
    }
  }

  // Get suggested prefetch priority based on match urgency
  getPrefetchPriority(scheduledAt: string): "high" | "normal" | "low" {
    const now = Date.now();
    const matchTime = new Date(scheduledAt).getTime();
    const minutesUntil = (matchTime - now) / (1000 * 60);

    if (minutesUntil < 30) return "high"; // Less than 30 min: high priority
    if (minutesUntil < 120) return "normal"; // Less than 2 hours: normal
    return "low"; // More than 2 hours: low priority
  }
}

// Cache invalidation coordinator: manages cache coherence across multiple layers
export class CacheInvalidator {
  private invalidationChains: Record<string, string[]> = {
    // When a match changes, invalidate related caches
    match: [
      "matches:live",
      "matches:upcoming",
      "matches:all",
      "schedule:all",
    ],
    // When a tournament changes, invalidate broader caches
    tournament: ["tournaments", "matches:all", "schedule:all"],
    // When a team changes
    team: ["teams", "matches:all"],
    // When game stats change
    game: [
      "games",
      "matches:stats",
      "player:stats",
    ],
  };

  async invalidateChain(
    entity: string,
    id: string,
    redis: any
  ): Promise<void> {
    const keysToInvalidate = this.invalidationChains[entity] || [];

    console.log(
      `[CacheInvalidator] Invalidating ${entity}:${id} chain: ${keysToInvalidate.join(", ")}`
    );

    for (const key of keysToInvalidate) {
      try {
        await redis.del(key);
        console.log(`[CacheInvalidator] Invalidated: ${key}`);
      } catch (error) {
        console.error(
          `[CacheInvalidator] Failed to invalidate ${key}:`,
          error
        );
      }
    }
  }

  addInvalidationRule(entity: string, keysToInvalidate: string[]): void {
    this.invalidationChains[entity] = keysToInvalidate;
  }
}

// Global instances
export const swr = new StaleWhileRevalidateCache();
export const cacheWarmer = new CacheWarmer();
export const predictiveLoader = new PredictiveLoader();
export const cacheInvalidator = new CacheInvalidator();
