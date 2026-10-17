import { Counter, Gauge, Histogram } from 'prom-client';

// DB Connection Pool Gauges
export const dbPoolTotalConnections = new Gauge({
  name: 'dorisio_db_pool_total_connections',
  help: 'Total number of connections in the database pool',
});

export const dbPoolIdleConnections = new Gauge({
  name: 'dorisio_db_pool_idle_connections',
  help: 'Number of idle connections available in the pool',
});

export const dbPoolActiveConnections = new Gauge({
  name: 'dorisio_db_pool_active_connections',
  help: 'Number of active connections checked out from the pool',
});

export const dbPoolWaitingClients = new Gauge({
  name: 'dorisio_db_pool_waiting_clients',
  help: 'Number of queries currently waiting for a database connection',
});

// DB Counters
export const dbPoolExhaustionCounter = new Counter({
  name: 'dorisio_db_pool_exhaustion_total',
  help: 'Total occurrences of connection pool exhaustion / timeouts',
});

export const dbCircuitBreakerStateGauge = new Gauge({
  name: 'dorisio_db_circuit_breaker_state',
  help: 'Current database circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
});

export const dbCircuitBreakerTripsCounter = new Counter({
  name: 'dorisio_db_circuit_breaker_trips_total',
  help: 'Total times the database circuit breaker has tripped to OPEN',
});

export const dbSlowQueriesCounter = new Counter({
  name: 'dorisio_db_slow_queries_total',
  help: 'Total count of slow database queries exceeding threshold',
  labelNames: ['query_name'],
});

export const dbConnectionLeaksCounter = new Counter({
  name: 'dorisio_db_connection_leaks_total',
  help: 'Total count of detected unreleased connection leaks',
});

export const dbQueryErrorsCounter = new Counter({
  name: 'dorisio_db_query_errors_total',
  help: 'Total database query errors',
  labelNames: ['error_code'],
});

export const dbQueryDuration = new Histogram({
  name: 'dorisio_db_query_duration_seconds_pool',
  help: 'Database query execution duration in seconds via connection pool',
  labelNames: ['query_name', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const dbCacheHitsCounter = new Counter({
  name: 'dorisio_db_cache_hits_total',
  help: 'Total query cache hits',
});

export const dbCacheMissesCounter = new Counter({
  name: 'dorisio_db_cache_misses_total',
  help: 'Total query cache misses',
});

export const dbCacheSizeGauge = new Gauge({
  name: 'dorisio_db_query_cache_entries',
  help: 'Number of entries currently held in the query result cache',
});

export const replicaQueriesTotal = new Counter({
  name: 'dorisio_db_replica_queries_total',
  help: 'Database queries routed to primary or read replicas',
  labelNames: ['target', 'status'],
});
export const replicaFallbacksTotal = new Counter({
  name: 'dorisio_db_replica_fallbacks_total',
  help: 'Queries that fell back from a read replica to primary',
});
export const replicaLagSeconds = new Gauge({
  name: 'dorisio_db_replica_lag_seconds',
  help: 'Observed replication lag by replica',
  labelNames: ['replica'],
});

export const dbCacheEvictionsCounter = new Counter({
  name: 'dorisio_db_cache_evictions_total',
  help: 'Total query cache evictions caused by capacity limits',
});

export const dbQueryCacheLatency = new Histogram({
  name: 'dorisio_db_cache_operation_duration_seconds',
  help: 'Duration of cache lookups and loads',
  labelNames: ['operation', 'result'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
});

// Prisma/ORM query instrumentation
export const prismaQueryDuration = new Histogram({
  name: 'dorisio_prisma_query_duration_seconds',
  help: 'Prisma query duration in seconds, labelled by model.operation',
  labelNames: ['model', 'operation', 'status', 'source'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const prismaQueryCount = new Counter({
  name: 'dorisio_prisma_query_total',
  help: 'Total Prisma queries executed, labelled by model.operation',
  labelNames: ['model', 'operation', 'status', 'source'],
});

export const prismaQueryRows = new Histogram({
  name: 'dorisio_prisma_query_rows',
  help: 'Rows returned per Prisma query',
  labelNames: ['model', 'operation'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 500, 1000, 5000],
});

export const prismaSlowQueriesCounter = new Counter({
  name: 'dorisio_prisma_slow_queries_total',
  help: 'Prisma queries exceeding the slow query threshold, labelled by model.operation',
  labelNames: ['model', 'operation'],
});

export const prismaCacheHitsCounter = new Counter({
  name: 'dorisio_prisma_cache_hits_total',
  help: 'Prisma queries served from the query result cache',
  labelNames: ['model', 'operation'],
});

export const prismaCacheMissesCounter = new Counter({
  name: 'dorisio_prisma_cache_misses_total',
  help: 'Prisma queries that missed the query result cache',
  labelNames: ['model', 'operation'],
});

export const prismaUnboundedReadsCounter = new Counter({
  name: 'dorisio_prisma_unbounded_reads_total',
  help: 'Prisma list reads executed without an explicit take/limit (potential unbounded result set)',
  labelNames: ['model', 'operation'],
});

export const prismaUnpaginatedReadsTotal = new Gauge({
  name: 'dorisio_prisma_unbounded_reads',
  help: 'Last observed number of unbounded Prisma list reads per process',
});

// Cache hit rate gauge (0-1) derived from Prisma cache hits/misses
export const prismaCacheHitRateGauge = new Gauge({
  name: 'dorisio_prisma_cache_hit_rate',
  help: 'Prisma query result cache hit rate (hits / (hits + misses)), 0-1',
  labelNames: ['model', 'operation'],
});

// Update the cache hit rate gauge for a given model.operation label pair.
// Called from prisma-performance instrumentation after each cache lookup.
export function updatePrismaCacheHitRate(
  model: string,
  operation: string,
  hits: number,
  misses: number,
): void {
  const total = hits + misses;
  const rate = total > 0 ? hits / total : 0;
  prismaCacheHitRateGauge.set({ model, operation }, rate);
}

// Aggregate cache hit/miss counters used to compute the overall hit rate
// exposed via the /health endpoint. Kept in-process to avoid scraping the
// prom-client registry on every health check.
const cacheHitTotals = new Map<string, { hits: number; misses: number }>();

export function recordPrismaCacheLookup(
  model: string,
  operation: string,
  hit: boolean,
): void {
  const key = `${model}.${operation}`;
  const entry = cacheHitTotals.get(key) ?? { hits: 0, misses: 0 };
  if (hit) {
    entry.hits += 1;
  } else {
    entry.misses += 1;
  }
  cacheHitTotals.set(key, entry);
  updatePrismaCacheHitRate(model, operation, entry.hits, entry.misses);
}

// Overall Prisma query cache hit rate (0-1) for /health exposure.
export function getPrismaCacheHitRate(): number {
  let hits = 0;
  let misses = 0;
  for (const entry of cacheHitTotals.values()) {
    hits += entry.hits;
    misses += entry.misses;
  }
  const total = hits + misses;
  return total > 0 ? hits / total : 0;
}

// Top slowest query patterns observed in this process
export const prismaTopSlowQueryGauge = new Gauge({
  name: 'dorisio_prisma_top_slow_query_duration_seconds',
  help: 'Duration of the slowest observed Prisma query pattern, labelled by model.operation',
  labelNames: ['model', 'operation', 'rank'],
});

export const prismaTopSlowQueryCountGauge = new Gauge({
  name: 'dorisio_prisma_top_slow_query_count',
  help: 'Number of slow occurrences for the top slowest Prisma query patterns',
  labelNames: ['model', 'operation', 'rank'],
});

// In-process tracker for the top N slowest query patterns.
// Keyed by "model.operation" -> { maxDurationSeconds, slowCount }.
const TOP_SLOW_QUERY_LIMIT = 3;
const topSlowQueryPatterns = new Map<
  string,
  { model: string; operation: string; maxDurationSeconds: number; slowCount: number }
>();

// Record a slow query occurrence and refresh the top-N gauges.
// Called from prisma-performance instrumentation whenever a query exceeds the
// slow query threshold.
export function recordPrismaSlowQuery(
  model: string,
  operation: string,
  durationSeconds: number,
): void {
  const key = `${model}.${operation}`;
  const existing = topSlowQueryPatterns.get(key);
  if (existing) {
    existing.slowCount += 1;
    if (durationSeconds > existing.maxDurationSeconds) {
      existing.maxDurationSeconds = durationSeconds;
    }
  } else {
    topSlowQueryPatterns.set(key, {
      model,
      operation,
      maxDurationSeconds: durationSeconds,
      slowCount: 1,
    });
  }
  refreshTopSlowQueryGauges();
}

function refreshTopSlowQueryGauges(): void {
  const ranked = Array.from(topSlowQueryPatterns.values())
    .sort((a, b) => b.maxDurationSeconds - a.maxDurationSeconds)
    .slice(0, TOP_SLOW_QUERY_LIMIT);

  // Reset previous label combinations so stale ranks do not linger.
  prismaTopSlowQueryGauge.reset();
  prismaTopSlowQueryCountGauge.reset();

  ranked.forEach((entry, index) => {
    const rank = String(index + 1);
    prismaTopSlowQueryGauge.set(
      { model: entry.model, operation: entry.operation, rank },
      entry.maxDurationSeconds,
    );
    prismaTopSlowQueryCountGauge.set(
      { model: entry.model, operation: entry.operation, rank },
      entry.slowCount,
    );
  });
}

// Snapshot of the top slow query patterns for exposure via /health.
export function getTopSlowQueryPatterns(): Array<{
  model: string;
  operation: string;
  maxDurationSeconds: number;
  slowCount: number;
}> {
  return Array.from(topSlowQueryPatterns.values())
    .sort((a, b) => b.maxDurationSeconds - a.maxDurationSeconds)
    .slice(0, TOP_SLOW_QUERY_LIMIT);
}
