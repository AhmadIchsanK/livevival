# Livevival Architecture & Development Roadmap

## Project Overview
Real-time tournament/esports match tracking with live streaming, admin console for match state management, and public viewing pages. Built on Next.js + Supabase + Redis caching.

## Phase Roadmap

### Phase 1: Data Reliability Layer ✅
**Status: Complete**
- Redis caching with 35-minute TTL
- 30-minute Vercel cron refresh cycle
- Cache-first pattern (Redis → Supabase)
- Web scraper fallback with rate limiting
- Admin cache control endpoints
- Graceful degradation on Redis unavailability

**Files:**
- `lib/redis.ts` - Upstash Redis client
- `app/api/cron/refresh-schedule/route.ts` - Schedule refresh (GET/POST)
- `lib/schedule-loader.ts` - Cache abstraction
- `services/liquipedia-scraper.ts` - Web scraper
- `vercel.json` - Cron configuration

### Phase 2: Performance Optimization (In Progress)
**Focus:** Query optimization, selective caching, data warming

**Goals:**
- Optimize frequently-accessed queries (live matches, upcoming schedule)
- Implement query result caching at database layer
- Add prefetching for public match pages
- Reduce N+1 queries
- Index optimization for match/tournament lookups

**Implementation:**
- Query cache layer with 5-15 minute TTLs
- Selective caching for public endpoints
- Data prefetching on app initialization
- Request deduplication for concurrent queries

### Phase 3: Monitoring & Observability (Upcoming)
**Focus:** Metrics, logging, performance tracking

**Goals:**
- Cache hit/miss ratio tracking
- Query performance metrics
- Error rate monitoring
- Uptime metrics for external dependencies
- Performance dashboard

**Implementation:**
- Structured logging with levels (debug/info/warn/error)
- Metrics collection service
- Performance tracing
- Admin dashboard for cache stats

### Phase 4: Advanced Caching & Scaling (Upcoming)
**Focus:** Cache efficiency, distributed patterns, resilience

**Goals:**
- Cache warming on app startup
- Predictive data loading based on match state
- Regional caching strategies
- Cache invalidation patterns
- Distributed cache coordination

**Implementation:**
- Cache warming jobs
- Smart prefetching based on match lifecycle
- Stale-while-revalidate patterns
- Cache coherence strategy

---

## Architecture Decisions

### Caching Strategy
- **Redis (Upstash)**: Distributed cache for schedule, match data (35min TTL)
- **In-Memory**: Small query results, frequently accessed data (5-15min TTL)
- **HTTP Cache-Control**: Public endpoints with 30s edge caching
- **SWR Pattern**: Stale-while-revalidate for non-critical data

### Data Flow
1. Client requests → Check Redis cache → Cache hit? return
2. Cache miss → Query Supabase → Populate Redis → Return
3. Cron job runs every 30 min → Refresh Redis from Supabase
4. Admin updates → Invalidate relevant cache keys → Force refresh

### Error Handling
- Redis unavailable → Fallback to direct Supabase queries
- Query errors → Return cached data if available (stale)
- Scraper failures → Use last known data from cache
- All errors logged, no user-facing exceptions

### Security
- CRON_SECRET for scheduled endpoints
- Admin RPC checks for cache operations
- Public endpoints read-only
- No sensitive data in cache

---

## Database Indexes (Recommended)
```sql
-- Performance indexes for common queries
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_scheduled_at ON matches(scheduled_at DESC);
CREATE INDEX idx_matches_tournament_id ON matches(tournament_id);
CREATE INDEX idx_games_match_id ON games(match_id);
CREATE INDEX idx_moments_match_id ON key_moments(match_id);
```

## Environment Variables
```
# Redis (Upstash)
UPSTASH_REDIS_URL
UPSTASH_REDIS_TOKEN

# Scheduled jobs
CRON_SECRET

# Optional: Performance monitoring
SENTRY_DSN (error tracking)
DATADOG_API_KEY (metrics)
```

---

## Key Files & Responsibilities

| File | Purpose |
|------|---------|
| `lib/redis.ts` | Redis client wrapper, cache operations |
| `lib/schedule-loader.ts` | High-level schedule fetching with caching |
| `app/api/cron/refresh-schedule/route.ts` | Scheduled cache refresh |
| `app/api/admin/cache-control/route.ts` | Admin cache management |
| `services/liquipedia-scraper.ts` | Web scraper with resilience |
| `lib/publicMatches.ts` | Public API with caching |
| `lib/queryCache.ts` | Query-level caching (Phase 2) |
| `lib/metrics.ts` | Performance metrics (Phase 3) |
| `lib/cachingStrategies.ts` | Advanced caching patterns (Phase 4) |

---

## Development Notes

### Adding New Cached Queries
1. Add to `lib/queryCache.ts` with appropriate TTL
2. Use `withCache()` wrapper in API endpoints
3. Invalidate on related admin operations
4. Monitor cache effectiveness in metrics

### Testing Cache Layer
```bash
# Test Redis connection
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-domain.vercel.app/api/admin/cache-control?action=status

# Clear cache (admin only)
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" \
  https://your-domain.vercel.app/api/admin/cache-control \
  -d '{"action":"clear-all"}'
```

### Monitoring Checklist
- [ ] Cache hit rate > 70% for peak hours
- [ ] P95 response time < 200ms
- [ ] Redis connection uptime > 99.9%
- [ ] Scraper success rate > 95%
- [ ] Error rate < 0.1%
