import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

function getRedisClient(): Redis {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN must be set");
  }

  redis = new Redis({ url, token });
  return redis;
}

export type CachedScheduleData = {
  tournaments: Array<{
    id: string;
    name: string;
    tier: string;
    liquipediaUrl?: string;
  }>;
  matches: Array<{
    id: string;
    status: string;
    scheduledAt: string | null;
    format: string | null;
    tournament: { id: string; name: string; tier: string } | null;
    teamA: { id: string; name: string } | null;
    teamB: { id: string; name: string } | null;
    streamUrl: string | null;
  }>;
  lastRefreshed: string;
};

export async function setSchedule(key: string, data: CachedScheduleData, ttlSeconds: number = 2100): Promise<void> {
  try {
    const client = getRedisClient();
    await client.setex(key, ttlSeconds, JSON.stringify(data));
    console.log(`[Redis] Cached schedule: ${key} (TTL: ${ttlSeconds}s)`);
  } catch (error) {
    console.error(`[Redis] Failed to cache schedule ${key}:`, error);
    throw error;
  }
}

export async function getSchedule(key: string): Promise<CachedScheduleData | null> {
  try {
    const client = getRedisClient();
    const cached = await client.get(key);

    if (!cached) {
      console.log(`[Redis] Cache miss: ${key}`);
      return null;
    }

    console.log(`[Redis] Cache hit: ${key}`);
    return JSON.parse(cached as string) as CachedScheduleData;
  } catch (error) {
    console.error(`[Redis] Failed to retrieve schedule ${key}:`, error);
    return null;
  }
}

export async function clearCache(key: string): Promise<void> {
  try {
    const client = getRedisClient();
    await client.del(key);
    console.log(`[Redis] Cleared cache: ${key}`);
  } catch (error) {
    console.error(`[Redis] Failed to clear cache ${key}:`, error);
  }
}

export async function getRedisMetrics(): Promise<{
  ping: string;
  uptime: number | null;
}> {
  try {
    const client = getRedisClient();
    const ping = await client.ping();
    console.log(`[Redis] Connected: ${ping}`);
    return { ping, uptime: null };
  } catch (error) {
    console.error(`[Redis] Connection failed:`, error);
    throw error;
  }
}
