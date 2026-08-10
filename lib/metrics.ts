// Performance metrics and monitoring
// Tracks cache hit rates, query performance, error rates

interface Metric {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

interface MetricBucket {
  name: string;
  metrics: Metric[];
  currentValue: number;
  total: number;
  average: number;
}

class MetricsCollector {
  private buckets = new Map<string, Metric[]>();
  private counters = new Map<string, number>();
  private maxMetricsPerBucket = 1000;

  // Record a metric value
  record(name: string, value: number, labels?: Record<string, string>): void {
    const key = labels ? `${name}:${JSON.stringify(labels)}` : name;

    if (!this.buckets.has(key)) {
      this.buckets.set(key, []);
    }

    const bucket = this.buckets.get(key)!;
    bucket.push({
      timestamp: Date.now(),
      value,
      labels,
    });

    // Keep only recent metrics to avoid memory explosion
    if (bucket.length > this.maxMetricsPerBucket) {
      bucket.shift();
    }
  }

  // Increment a counter
  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  // Get counter value
  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  // Calculate hit rate for a metric (e.g., cache hits vs misses)
  getHitRate(hitKey: string, missKey: string): number {
    const hits = this.getCounter(hitKey);
    const misses = this.getCounter(missKey);
    const total = hits + misses;

    if (total === 0) return 0;
    return (hits / total) * 100;
  }

  // Get average value over time window
  getAverage(name: string, windowMs = 300000): number {
    // Default 5 minutes
    const metrics = this.buckets.get(name) || [];
    const now = Date.now();
    const recentMetrics = metrics.filter((m) => now - m.timestamp < windowMs);

    if (recentMetrics.length === 0) return 0;
    const sum = recentMetrics.reduce((acc, m) => acc + m.value, 0);
    return sum / recentMetrics.length;
  }

  // Get P95 (95th percentile)
  getPercentile(name: string, percentile = 95, windowMs = 300000): number {
    const metrics = this.buckets.get(name) || [];
    const now = Date.now();
    const recentMetrics = metrics
      .filter((m) => now - m.timestamp < windowMs)
      .sort((a, b) => a.value - b.value);

    if (recentMetrics.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * recentMetrics.length) - 1;
    return recentMetrics[index].value;
  }

  // Get all metrics for dashboard
  getAllMetrics() {
    const result: Record<string, MetricBucket> = {};

    for (const [key, metrics] of this.buckets.entries()) {
      if (metrics.length === 0) continue;

      const values = metrics.map((m) => m.value);
      result[key] = {
        name: key,
        metrics: metrics.slice(-100), // Last 100 for efficiency
        currentValue: metrics[metrics.length - 1].value,
        total: values.reduce((a, b) => a + b, 0),
        average: values.reduce((a, b) => a + b, 0) / values.length,
      };
    }

    return result;
  }

  // Health check: returns overall system health
  getHealthStatus() {
    const cacheHitRate = this.getHitRate("cache:hit", "cache:miss");
    const errorRate =
      (this.getCounter("errors:total") /
        (this.getCounter("requests:total") || 1)) *
      100;
    const avgResponseTime = this.getAverage("response_time_ms");

    return {
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      avgResponseTimeMs: Math.round(avgResponseTime),
      isHealthy:
        cacheHitRate > 50 && errorRate < 1 && avgResponseTime < 500,
    };
  }

  // Reset all metrics
  reset(): void {
    this.buckets.clear();
    this.counters.clear();
    console.log("[Metrics] All metrics reset");
  }
}

// Global metrics instance
export const metrics = new MetricsCollector();

// Common metric recording helpers
export function recordCacheHit(type: string): void {
  metrics.increment(`cache:hit:${type}`);
  metrics.increment("cache:hit");
}

export function recordCacheMiss(type: string): void {
  metrics.increment(`cache:miss:${type}`);
  metrics.increment("cache:miss");
}

export function recordQueryTime(name: string, durationMs: number): void {
  metrics.record("query_time_ms", durationMs, { query: name });
}

export function recordResponseTime(durationMs: number): void {
  metrics.record("response_time_ms", durationMs);
}

export function recordError(type: string): void {
  metrics.increment(`errors:${type}`);
  metrics.increment("errors:total");
}

export function recordRequest(): void {
  metrics.increment("requests:total");
}

// Middleware helper for automatic request tracking
export function metricsMiddleware(duration: number, error?: Error): void {
  recordResponseTime(duration);
  recordRequest();
  if (error) {
    recordError(error.name || "unknown");
  }
}
