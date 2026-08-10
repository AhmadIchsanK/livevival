"use client";

import { useEffect, useState } from "react";

interface HealthStatus {
  cacheHitRate: number;
  errorRate: number;
  avgResponseTimeMs: number;
  isHealthy: boolean;
}

interface QueryCacheStats {
  cacheSize: number;
  memorySizeBytes: number;
  expiredEntries: number;
  percentExpired: number;
}

interface Summary {
  cacheHitRate: number;
  queryAverageTimeMs: number;
  responseP95Ms: number;
  queryCacheStats: QueryCacheStats;
  totalRequests: number;
  totalErrors: number;
  cronRefreshes: number;
}

interface MetricsData {
  timestamp: string;
  health: HealthStatus;
  summary: Summary;
  metrics: Record<string, unknown>;
}

export default function MonitoringPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchMetrics = async () => {
    try {
      const response = await fetch("/api/admin/metrics");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const metrics = await response.json();
      setData(metrics);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch metrics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();

    if (!autoRefresh) return;

    const interval = setInterval(fetchMetrics, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [autoRefresh]);

  if (loading && !data) {
    return (
      <div className="p-8">
        <div className="text-center text-gray-400">Loading metrics...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-red-950 border border-red-700 p-4 text-red-200">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8">
        <div className="text-center text-gray-400">No data available</div>
      </div>
    );
  }

  const { health, summary } = data;

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">System Monitoring</h1>
        <div className="space-x-4">
          <button
            onClick={fetchMetrics}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition"
          >
            Refresh Now
          </button>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-4 py-2 rounded-lg transition ${
              autoRefresh
                ? "bg-green-600 hover:bg-green-700"
                : "bg-gray-600 hover:bg-gray-700"
            } text-white`}
          >
            {autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          </button>
        </div>
      </div>

      <div className="text-sm text-gray-400">
        Last updated: {new Date(data.timestamp).toLocaleTimeString()}
      </div>

      {/* Health Status */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div
          className={`p-4 rounded-lg border ${
            health.isHealthy
              ? "border-green-700 bg-green-950"
              : "border-yellow-700 bg-yellow-950"
          }`}
        >
          <div className="text-sm text-gray-400">Overall Health</div>
          <div className="text-2xl font-bold mt-2">
            {health.isHealthy ? "✓ Healthy" : "⚠ Degraded"}
          </div>
        </div>

        <div className="p-4 rounded-lg border border-blue-700 bg-blue-950">
          <div className="text-sm text-gray-400">Cache Hit Rate</div>
          <div className="text-2xl font-bold mt-2">{health.cacheHitRate}%</div>
          <div className="text-xs text-gray-500 mt-1">
            {health.cacheHitRate > 70 ? "✓ Good" : "⚠ Needs improvement"}
          </div>
        </div>

        <div className="p-4 rounded-lg border border-purple-700 bg-purple-950">
          <div className="text-sm text-gray-400">Avg Response Time</div>
          <div className="text-2xl font-bold mt-2">{health.avgResponseTimeMs}ms</div>
          <div className="text-xs text-gray-500 mt-1">
            {health.avgResponseTimeMs < 200 ? "✓ Fast" : "⚠ Slow"}
          </div>
        </div>

        <div className="p-4 rounded-lg border border-red-700 bg-red-950">
          <div className="text-sm text-gray-400">Error Rate</div>
          <div className="text-2xl font-bold mt-2">{health.errorRate}%</div>
          <div className="text-xs text-gray-500 mt-1">
            {health.errorRate < 0.1 ? "✓ Excellent" : "⚠ High"}
          </div>
        </div>
      </div>

      {/* Detailed Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border border-gray-700 bg-gray-900">
          <h2 className="font-bold text-lg mb-4">Request Statistics</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Total Requests</span>
              <span className="font-mono">{summary.totalRequests}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Total Errors</span>
              <span className={summary.totalErrors > 0 ? "text-red-400" : ""}>
                {summary.totalErrors}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cron Refreshes</span>
              <span className="font-mono">{summary.cronRefreshes}</span>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-gray-700 bg-gray-900">
          <h2 className="font-bold text-lg mb-4">Query Performance</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Average Query Time</span>
              <span className="font-mono">{summary.queryAverageTimeMs}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">P95 Response Time</span>
              <span className="font-mono">{summary.responseP95Ms}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Cache Hit Rate</span>
              <span className="font-mono">{summary.cacheHitRate}%</span>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-gray-700 bg-gray-900">
          <h2 className="font-bold text-lg mb-4">Query Cache</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Cached Entries</span>
              <span className="font-mono">{summary.queryCacheStats.cacheSize}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Memory Usage</span>
              <span className="font-mono">
                {(summary.queryCacheStats.memorySizeBytes / 1024 / 1024).toFixed(2)}MB
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Expired Entries</span>
              <span className="font-mono">
                {summary.queryCacheStats.expiredEntries}
                <span className="text-gray-600 text-xs ml-1">
                  ({summary.queryCacheStats.percentExpired}%)
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-gray-700 bg-gray-900">
          <h2 className="font-bold text-lg mb-4">Health Indicators</h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center">
              <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                health.cacheHitRate > 70 ? "bg-green-500" : "bg-yellow-500"
              }`}></span>
              <span>Cache Hit Rate {health.cacheHitRate > 70 ? "✓" : "⚠"}</span>
            </div>
            <div className="flex items-center">
              <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                health.errorRate < 1 ? "bg-green-500" : "bg-red-500"
              }`}></span>
              <span>Error Rate {health.errorRate < 1 ? "✓" : "⚠"}</span>
            </div>
            <div className="flex items-center">
              <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
                health.avgResponseTimeMs < 500 ? "bg-green-500" : "bg-yellow-500"
              }`}></span>
              <span>Response Time {health.avgResponseTimeMs < 500 ? "✓" : "⚠"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Recommendations */}
      {!health.isHealthy && (
        <div className="p-4 rounded-lg border border-yellow-700 bg-yellow-950">
          <h2 className="font-bold text-yellow-200 mb-2">Recommendations</h2>
          <ul className="text-sm text-yellow-100 space-y-1 list-disc list-inside">
            {health.cacheHitRate < 70 && (
              <li>Cache hit rate is low. Consider adjusting TTL settings or warming cache more aggressively.</li>
            )}
            {health.errorRate > 1 && (
              <li>Error rate is elevated. Check logs for error patterns and database connectivity.</li>
            )}
            {health.avgResponseTimeMs > 500 && (
              <li>Response times are high. Optimize slow queries or add database indexes.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
