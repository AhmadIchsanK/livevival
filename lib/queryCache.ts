import { createClient } from "@supabase/supabase-js";
import { getSchedule, setSchedule } from "@/lib/redis";

export type CacheStrategy = "short" | "medium" | "long" | "skip";

export interface CacheConfig {
  strategy: CacheStrategy;
  ttl?: number;
  key: string;
}

const CACHE_DURATIONS = {
  short: 300, // 5 minutes
  medium: 900, // 15 minutes
  long: 3600, // 1 hour
};

interface CachedQuery {
  data: unknown;
  timestamp: number;
  ttl: number;
}

let localCache = new Map<string, CachedQuery>();
let requestDedup = new Map<string, Promise<unknown>>();

export async function withQueryCache<T>(
  config: CacheConfig,
  queryFn: () => Promise<T>
): Promise<T> {
  if (config.strategy === "skip") {
    return queryFn();
  }

  const cacheKey = `query:${config.key}`;
  const ttl = config.ttl || CACHE_DURATIONS[config.strategy];

  // Check local in-memory cache first (faster)
  const cached = localCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
    console.log(`[QueryCache] Memory hit: ${cacheKey}`);
    return cached.data as T;
  }

  // Request deduplication: if another request is already fetching this data, wait for it
  if (requestDedup.has(cacheKey)) {
    console.log(`[QueryCache] Dedup hit: ${cacheKey}`);
    return (await requestDedup.get(cacheKey)) as T;
  }

  // Start the fetch and store the promise for deduplication
  const fetchPromise = queryFn();
  requestDedup.set(cacheKey, fetchPromise);

  try {
    const result = await fetchPromise;

    // Store in local cache
    localCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
      ttl,
    });

    console.log(`[QueryCache] Cached: ${cacheKey} (TTL: ${ttl}s)`);
    return result;
  } finally {
    // Remove from dedup map
    requestDedup.delete(cacheKey);
  }
}

// Clear local cache for a specific key or all keys
export function clearQueryCache(pattern?: string): void {
  if (!pattern) {
    localCache.clear();
    console.log("[QueryCache] Cleared all local cache");
    return;
  }

  let cleared = 0;
  for (const key of localCache.keys()) {
    if (key.includes(pattern)) {
      localCache.delete(key);
      cleared++;
    }
  }
  console.log(`[QueryCache] Cleared ${cleared} entries matching '${pattern}'`);
}

// Get cache statistics
export function getQueryCacheStats() {
  let totalSize = 0;
  let expiredCount = 0;

  for (const [key, cached] of localCache.entries()) {
    totalSize += JSON.stringify(cached.data).length;
    if (Date.now() - cached.timestamp > cached.ttl * 1000) {
      expiredCount++;
    }
  }

  return {
    cacheSize: localCache.size,
    memorySizeBytes: totalSize,
    expiredEntries: expiredCount,
    percentExpired: Math.round((expiredCount / localCache.size) * 100) || 0,
  };
}

// Cleanup expired entries (run periodically)
export function cleanupExpiredCache(): number {
  let removed = 0;
  for (const [key, cached] of localCache.entries()) {
    if (Date.now() - cached.timestamp > cached.ttl * 1000) {
      localCache.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[QueryCache] Cleaned up ${removed} expired entries`);
  }
  return removed;
}

// Prefetch common queries on app initialization
export async function prefetchCommonQueries() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  console.log("[QueryCache] Starting common data prefetch...");

  try {
    // Prefetch tournaments
    await withQueryCache(
      { strategy: "long", key: "tournaments:all" },
      async () => {
        const { data } = await supabase.from("tournaments").select("*");
        return data;
      }
    );

    // Prefetch live matches
    await withQueryCache(
      { strategy: "short", key: "matches:live" },
      async () => {
        const { data } = await supabase
          .from("matches")
          .select("*")
          .eq("status", "live")
          .limit(50);
        return data;
      }
    );

    // Prefetch upcoming matches (next 7 days)
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    await withQueryCache(
      { strategy: "medium", key: "matches:upcoming:week" },
      async () => {
        const { data } = await supabase
          .from("matches")
          .select("*")
          .eq("status", "scheduled")
          .gte("scheduled_at", now.toISOString())
          .lte("scheduled_at", weekFromNow.toISOString())
          .order("scheduled_at", { ascending: true })
          .limit(100);
        return data;
      }
    );

    console.log("[QueryCache] Common data prefetch completed");
  } catch (error) {
    console.error("[QueryCache] Prefetch failed:", error);
  }
}
