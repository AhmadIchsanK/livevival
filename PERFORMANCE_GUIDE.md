# Performance Optimization Guide (Phases 2-4)

This document details the performance optimizations implemented across Phases 2, 3, and 4.

## Phase 2: Query-Level Caching & Performance Optimization

### Query Cache Layer (`lib/queryCache.ts`)

Implements intelligent caching for database queries with automatic invalidation.

**Features:**
- **Three-tier TTL strategy:**
  - `short` (5 min): Live data, frequent changes (live matches, current stats)
  - `medium` (15 min): Semi-static data (upcoming matches, tournaments)
  - `long` (1 hour): Static reference data (tournament info, historical stats)

- **Request deduplication:** If 10 concurrent requests for the same query arrive, only 1 hits the database. Others wait for the first response.

- **In-memory local cache:** Faster than Redis for frequently accessed data. Cleared on deployment.

**Usage Example:**
```typescript
import { withQueryCache } from "@/lib/queryCache";

const matches = await withQueryCache(
  { strategy: "short", key: "matches:live" },
  async () => {
    return await supabase.from("matches").select("*").eq("status", "live");
  }
);
```

### Common Query Caching Strategy

**Cached by default:**
- Live matches (5 min TTL)
- Upcoming matches (15 min TTL)
- Tournaments (1 hour TTL)
- Team rosters (30 min TTL)

**Monitor effectiveness:**
```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  https://your-domain.vercel.app/api/admin/metrics
```

Look for `cacheHitRate > 70%` in peak hours.

## Phase 3: Observability & Metrics

### Metrics Collection (`lib/metrics.ts`)

Automatic tracking of:
- Cache hit/miss rates by type
- Query execution times (average, P95, P99)
- Response times
- Error rates and types
- Request counts

**Health Status Endpoint:**
```bash
GET /api/admin/metrics
```

Returns:
```json
{
  "health": {
    "cacheHitRate": 75.5,
    "errorRate": 0.02,
    "avgResponseTimeMs": 145,
    "isHealthy": true
  },
  "summary": {
    "totalRequests": 15234,
    "totalErrors": 3,
    "queryCacheStats": {
      "cacheSize": 42,
      "memorySizeBytes": 2150000,
      "expiredEntries": 2
    }
  }
}
```

### Logging Strategy

All caching layers log at appropriate levels:

| Level | When | Example |
|-------|------|---------|
| debug | Cache state changes, prefetch activities | `[QueryCache] Memory hit: matches:live` |
| info | Normal operations | `[Cron] Schedule refresh completed in 245ms` |
| warn | Degraded operations | `[ScheduleLoader] Redis unavailable, falling back` |
| error | Failures requiring attention | `[Redis] Connection failed: ECONNREFUSED` |

## Phase 4: Advanced Caching Strategies

### Stale-While-Revalidate (`lib/cachingStrategies.ts`)

Serves cached data immediately while fetching fresh data in the background.

**Benefit:** Users always get instant responses. Data may be slightly stale but becomes fresh within seconds.

**Configuration:**
```typescript
import { swr } from "@/lib/cachingStrategies";

const data = await swr.get(
  "matches:live",
  5 * 60 * 1000, // Stale after 5 minutes
  async () => {
    // Fetch fresh data
    return await supabase.from("matches").select("*");
  }
);
```

### Cache Warming (`CacheWarmer`)

Pre-loads critical data on app startup and periodically refreshes it.

**Default rules:**
1. On init (high priority):
   - Load all tournaments
   - Load live matches
   
2. On schedule (normal priority):
   - Load upcoming matches for next 7 days
   
3. On state change (predictive):
   - Load matches grouped by state

### Predictive Loading (`PredictiveLoader`)

Anticipates match state transitions and prefetches related data.

**Example:** When a match transitions from `DRAFT_STARTED` → `GAME_STARTED`, prefetch:
- Game stats structures
- Player pick/ban histories
- Live data preparation

### Cache Invalidation Coordination (`CacheInvalidator`)

Manages cache coherence across multiple layers when data changes.

**Invalidation chains:**
- Match update → invalidates: `matches:live`, `matches:upcoming`, `schedule:all`
- Tournament update → invalidates: `tournaments`, `matches:all`
- Team update → invalidates: `teams`, `matches:all`

**Usage:**
```typescript
import { cacheInvalidator } from "@/lib/cachingStrategies";

// When admin updates a match
await cacheInvalidator.invalidateChain("match", matchId, redis);
```

## Performance Targets & Monitoring

### Target Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Cache hit rate | > 70% | Monitor at `/api/admin/metrics` |
| P95 response time | < 200ms | Track via metrics dashboard |
| Error rate | < 0.1% | Alert if > 1% |
| Redis uptime | > 99.9% | Monitor connection status |
| Query avg time | < 100ms | Optimize queries > 200ms |

### Performance Monitoring Checklist

**Daily:**
- [ ] Check cache hit rate (should be > 70%)
- [ ] Verify error rate (should be < 0.1%)
- [ ] Review slow queries (> 200ms)

**Weekly:**
- [ ] Analyze metrics trends
- [ ] Check Redis connection stability
- [ ] Review cache effectiveness by data type

**Monthly:**
- [ ] Audit cache invalidation chains for redundancy
- [ ] Update TTLs based on data freshness requirements
- [ ] Review prefetch rules effectiveness

### Debugging Performance Issues

**High error rate (> 1%)?**
1. Check `/api/admin/metrics` for error types
2. Review error logs for patterns
3. Check Redis/database connection status

**Low cache hit rate (< 50%)?**
1. Verify query cache is working: check logs for `[QueryCache]` entries
2. Review TTL settings - may be too short
3. Check if cache is being cleared unexpectedly

**Slow response times (P95 > 500ms)?**
1. Check query execution times in metrics
2. Review database indexes (see CLAUDE.md)
3. Enable predictive loading for frequently accessed data

**Memory usage growing?**
1. Call `/api/admin/metrics` to check query cache size
2. Run manual cleanup: `clearQueryCache()`
3. Review in-memory cache retention policies

## Configuration Examples

### Adjusting Cache TTLs

Edit `lib/queryCache.ts`:
```typescript
const CACHE_DURATIONS = {
  short: 300,   // 5 minutes - adjust for live data freshness
  medium: 900,  // 15 minutes - adjust for semi-static data
  long: 3600,   // 1 hour - adjust for reference data
};
```

### Adding New Cached Queries

```typescript
// In your API route
import { withQueryCache } from "@/lib/queryCache";

export async function GET(req: NextRequest) {
  const stats = await withQueryCache(
    { strategy: "medium", key: "player:stats:leaderboard" },
    async () => {
      return await supabase
        .from("players")
        .select("name, wins, losses")
        .order("wins", { ascending: false })
        .limit(100);
    }
  );
  
  return NextResponse.json(stats);
}
```

### Monitoring Custom Metrics

```typescript
import { metrics, recordQueryTime } from "@/lib/metrics";

const startTime = Date.now();
const result = await expensiveQuery();
recordQueryTime("my_expensive_query", Date.now() - startTime);
```

## Future Optimizations

### Phase 5 (Upcoming)
- [ ] Distributed caching with multiple Redis nodes
- [ ] Regional caching for global scale
- [ ] Machine learning-based predictive prefetching
- [ ] GraphQL caching layer
- [ ] Database connection pooling optimization

### Phase 6 (Upcoming)
- [ ] Compression for cached data
- [ ] Bloom filters for cache miss prediction
- [ ] Adaptive TTL based on access patterns
- [ ] Cache tiering (hot/warm/cold data)

## Support & Troubleshooting

For issues or questions about performance:
1. Check metrics at `/api/admin/metrics`
2. Review logs for `[QueryCache]`, `[Metrics]`, `[SWR]` entries
3. Consult this guide's "Debugging" section
4. Review CLAUDE.md architecture decisions
