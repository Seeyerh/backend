import { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { QueryCache } from './query-cache';
import { QueryLogger, normalizeQueryName } from './query-logger';
import {
  prismaCacheHitsCounter,
  prismaGacheMissesCounter,
  prismaQueryCount,
  prismaQueryDuration,
  prismaQueryRows,
  prismaSlowQueriesCounter,
  prismaUnboundedReadsCounter,
  recordPrismaSlowQuery,
} from './metrics';

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/* Cached reads stay short-lived; writes invalidate the affected model tag. */
export const PRISMA_CACHE_DEFAULT_TTL_MS = 60_000;
const PRISMA_CACHE_MAX_TTL_MS = 5 * 60_000;
const UNBOUNDED_READ_WARN_INTERVAL_MS = 60_000;
const TOP_SLOW_QUERY_LIMIT = 10;
const TOP_SLOW_QUERY_PATTERN_LIMIT = 3;
const SLOW_PATTERN_REPORT_INTERVAL_MS = 5_000;
/** Guards the recursive projection scan against pathological nesting. */
const MAX_PROJECTION_DEPTH = 5;
const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'secret',
  'token',
  'refreshToken',
  'apiKey',
  'privateKey',
  'secretKey',
  'signingSecret',
  'stellarServerSecretKey',
  'clientSecret',
];

export interface PrismaPerformanceOptions {
  slowQueryThresholdMs?: number;
  logQueries?: boolean;
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  /** Warn (at most once per interval) when a list read has no `take`. */
  warnOnUnboundedReads?: boolean;
}

export interface PrismaOperationStats {
  count: number;
  errors: number;
  cacheHits: number;
  cacheMisses: number;
  totalDurationMs: number;
  maxDurationMs: number;
  slowQueries: number;
  rows: number;
}

export interface PrismaSlowQueryPattern {
  operation: string;
  count: number;
  maxDurationMs: number;
  avgDurationMs: number;
}

export interface PrismaPerformanceStats {
  totalQueries: number;
  totalErrors: number;
  slowQueries: number;
  cacheHits: number;
  cacheMisses: number;
  unboundedReads: number;
  totalDurationMs: number;
  maxDurationMs: number;
  operations: Record<string, PrismaOperationStats>;
  cache: {
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
  };
  /** Top slow query patterns by count, for the /health endpoint. */
  topSlowQueries: PrismaSlowQueryPattern[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects `select`/`include` projections that would pull credentials or signing
 * material into the process cache. Walks the whole projection tree, since
 * relations are nested arbitrarily deep.
 */
function selectsSensitiveFields(args: Record<string, unknown>, depth = 0): boolean {
  if (depth > MAX_PROJECTION_DEPTH) return false;

  for (const candidate of [args.select, args.include]) {
    if (!isPlainObject(candidate)) continue;

    for (const [key, value] of Object.entries(candidate)) {
      if (SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
        return true;
      }
      if (isPlainObject(value) && selectsSensitiveFields({ select: value }, depth + 1)) {
        return true;
      }
    }
  }

  return false;
}

function countRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return result === null || result === undefined ? 0 : 1;
}

export function defaultPrismaPerformanceOptions(): Required<PrismaPerformanceOptions> {
  return {
    slowQueryThresholdMs: config.DB_SLOW_QUERY_THRESHOLD_MS ?? 200,
    logQueries: config.DB_LOG_QUERIES ?? false,
    cacheEnabled: config.DB_QUERY_CACHE_ENABLED !== false,
    cacheTtlMs: config.DB_QUERY_CACHE_TTL_MS ?? PRISMA_CACHE_DEFAULT_TTL_MS,
    cacheMaxEntries: 500,
    warnOnUnboundedReads: true,
  };
}

export class PrismaPerformanceMonitor {
  private readonly queryLogger: QueryLogger;
  private readonly cache: QueryCache;
  private readonly options: Required<PrismaPerformanceOptions>;
  private readonly operations = new Map<string, PrismaOperationStats>();
  private readonly lastUnboundedWarn = new Map<string, number>();
  private unboundedReads = 0;
  private client: PrismaClient | null = null;
  private slowPatternTimer: NodeJS.Timeout | null = null;

  constructor(options: PrismaPerformanceOptions = {}) {
    this.options = { ...defaultPrismaPerformanceOptions(), ...options };
    this.queryLogger = new QueryLogger({
      slowQueryThresholdMs: this.options.slowQueryThresholdMs,
      logQueries: this.options.logQueries,
    });
    this.cache = new QueryCache({
      defaultTtlMs: Math.min(this.options.cacheTtlMs, PRISMA_CACHE_MAX_TTL_MS),
      maxEntries: this.options.cacheMaxEntries,
      maxTtlMs: PRISMA_CACHE_MAX_TTL_MS,
    });
  }

  get slowQueryThresholdMs(): number {
    return this.options.slowQueryThresholdMs;
  }

  get isCacheEnabled(): boolean {
    return this.options.cacheEnabled;
  }

  /**
   * Returns a Prisma client wrapped in a query extension that records
   * duration metrics, flags slow queries, caches safe read operations, and
   * invalidates the affected cache tags on writes.
   */
  instrument(client: PrismaClient): PrismaClient {
    this.client = client;
    const handleOperation = this.handleOperation.bind(this);

    return client.$extends({
      name: 'query-performance',
      query: {
        $allModels: {
          $allOperations: (context: {
            model: string;
            operation: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }) => handleOperation(context),
        },
      },
    }) as unknown as PrismaClient;
  }

  private async handleOperation(context: {
    model: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }): Promise<unknown> {
    const { model, operation } = context;
    const queryArgs = (context.args ?? {}) as Record<string, unknown>;
    const run = context.query as () => Promise<unknown>;
    const key = `${model}.${operation}`;
    const isWrite = WRITE_OPERATIONS.has(operation);
    const isRead = READ_OPERATIONS.has(operation);

    if (isRead && operation === 'findMany' && queryArgs.take === undefined) {
      this.recordUnboundedRead(model, operation);
    }

    if (this.options.cacheEnabled && isRead && !selectsSensitiveFields(queryArgs)) {
      const cacheKey = this.cache.generateKey(key, queryArgs);
      const tag = `model:${model}`;
      const peeked = this.cache.peek(cacheKey);

      if (peeked.hit) {
        this.recordCacheHit(key);
        return peeked.value;
      }

      return this.cache.getOrLoad(
        cacheKey,
        async () => {
          this.recordCacheMiss(key);
          return this.execute(key, model, operation, queryArgs, run);
        },
        this.cacheTtl,
        [tag],
        false
      );
    }

    try {
      return await this.execute(key, model, operation, queryArgs, run);
    } finally {
      if (isWrite) {
        const invalidated = this.cache.invalidateTags([`model:${model}`]);
        if (invalidated > 0) {
          logger.debug({ model, invalidated }, 'Invalidated cached reads after write');
        }
      }
    }
  }

  get cacheTtl(): number {
    return Math.min(this.options.cacheTtlMs, PRISMA_CACHE_MAX_TTL_MS);
  }

  private async execute(
    key: string,
    model: string,
    operation: string,
    args: Record<string, unknown>,
    run: () => Promise<unknown>
  ): Promise<unknown> {
    const start = process.hrtime.bigint();
    let result: unknown;
    let status: 'success' | 'error' = 'success';

    try {
      result = await run();
      return result;
    } catch (error) {
      status = 'error';
      this.recordStats(key, model, operation, 0, true, 0);
      this.queryLogger.logQuery({
        queryName: normalizeQueryName(key),
        operation: key,
        fingerprint: key,
        params: args,
        durationMs: this.elapsedMs(start),
        error,
      });
      throw error;
    } finally {
      if (status === 'success') {
        const durationMs = this.elapsedMs(start);
        const rows = countRows(result);
        this.recordStats(key, model, operation, durationMs, false, rows);

        prismaQueryDuration.observe(
          { model, operation, status, source: 'prisma' },
          durationMs / 1000
        );
        prismaQueryCount.inc({ model, operation, status, source: 'prisma' });
        prismaQueryRows.observe({ model, operation }, rows);

        if (durationMs >= this.options.slowQueryThresholdMs) {
          prismaSlowQueriesCounter.inc({ model, operation });
          recordPrismaSlowQuery(model, operation, durationMs / 1000);
        }

        this.queryLogger.logQuery({
          queryName: normalizeQueryName(key),
          operation: key,
          fingerprint: key,
          params: args,
          durationMs,
          rowCount: rows,
        });
      }
    }
  }

  private elapsedMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  private recordStats(
    key: string,
    _model: string,
    _operation: string,
    durationMs: number,
    isError: boolean,
    rows: number
  ): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };

    existing.count += 1;
    if (isError) {
      existing.errors += 1;
    } else {
      existing.totalDurationMs += durationMs;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.rows += rows;
      if (durationMs >= this.options.slowQueryThresholdMs) {
        existing.slowQueries += 1;
      }
    }

    this.operations.set(key, existing);
  }

  private recordCacheMiss(key: string): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };
    existing.cacheMisses += 1;
    this.operations.set(key, existing);
    prismaGacheMissesCounter.inc({
      model: key.split('.')[0] ?? 'unknown',
      operation: key.split('.')[1] ?? key,
    });
  }

  private recordCacheHit(key: string): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };
    existing.cacheHits += 1;
    this.operations.set(key, existing);
    prismaGacheHitsCounter.inc({
      model: key.split('.')[0] ?? 'unknown',
      operation: key.split('.')[1] ?? key,
    });
  }

  private recordUnboundedRead(model: string, operation: string): void {
    this.unboundedReads += 1;
    prismaUnboundedReadsCounter.inc({ model, operation });

    if (!this.options.warnOnUnboundedReads) return;
    const key = `${model}.${operation}`;
    const now = Date.now();
    const last = this.lastUnboundedWarn.get(key) ?? 0;
    if (now - last < UNDOUNDED_READ_WARN_INTERVAL_MS) return;
    this.lastUnboundedWarn.set(key, now);
    logger.warn({ model, operation }, 'Unbounded Prisma list read (no take)');
  }

  getStats(): PrismaPerformanceStats {
    let totalQueries = 0;
    let totalErrors = 0;
    let slowQueries = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let totalDurationMs = 0;
    let maxDurationMs = 0;
    const operations: Record<string, PrismaOperationStats> = {};

    for (const [key, stats] of this.operations) {
      operations[key] = { ...stats };
      totalQueries += stats.count;
      totalErrors += stats.errors;
      slowQueries += stats.slowQueries;
      cacheHits += stats.cacheHits;
      cacheMisses += stats.cacheMisses;
      totalDurationMs += stats.totalDurationMs;
      maxDurationMs = Math.max(maxDurationMs, stats.maxDurationMs);
    }

    const cacheStats = this.cache.getStats();
    const cacheTotal = cacheStats.hits + cacheStats.misses;
    const topSlowQueries = this.getTopSlowPatterns();

    return {
      totalQueries,
      totalErrors,
      slowQueries,
      cacheHits,
      cacheMisses,
      unboundedReads: this.unboundedReads,
      totalDurationMs,
      maxDurationMs,
      operations,
      cache: {
        entries: cacheStats.entries,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        hitRate: cacheTotal > 0 ? cacheStats.hits / cacheTotal : 0,
        evictions: cacheStats.evictions,
      },
      topSlowQueries,
    };
  }

  getTopSlowPatterns(): PrismaSlowQueryPattern[] {
    return Array.from(this.operations.entries())
      .map(([key, stats]) => ({
        operation: key,
        count: stats.slowQueries,
        maxDurationMs: stats.maxDurationMs,
        avgDurationMs: stats.count > 0 ? stats.totalDurationMs / stats.count : 0,
      }))
      .filter((pattern) => pattern.count > 0)
      .sort((a, b) => b.maxDurationMs - a.maxDurationMs)
      .slice(0, TOP_SLOW_QUERY_PATTERN_LIMIT);
  }

  /** Logs the top slow query patterns on an interval so contributors can spot them from logs. */
  startSlowPatternReporter(): void {
    if (this.slowPatternTimer) return;
    this.slowPatternTimer = setInterval(() => {
      const top = this.getTopSlowPatterns();
      if (top.length > 0) {
        logger.info({ topSlowQueryPatterns: top }, 'Top slow Prisma query patterns');
      }
    }, SLOW_PATTERN_REPORT_INTERVAL_MS);
    this.slowPatternTimer.unref();
  }

  stopSlowPatternReporter(): void {
    if (this.slowPatternTimer) {
      clearInterval(this.slowPatternTimer);
      this.slowPatternTimer = null;
    }
  }
}

let monitor: PrismaPerformanceMonitor | null = null;

export function getPrismaPerformanceMonitor(): PrismaPerformanceMonitor {
  if (!monitor) {
    monitor = new PrismaPerformanceMonitor();
  }
  return monitor;
}

export function createInstrumentedPrismaClient(): {
  client: PrismaClient;
  monitor: PrismaPerformanceMonitor;
} {
  const base = new PrismaClient();
  const instrumentedMonitor = getPrismaPerformanceMonitor();
  const client = instrumentedMonitor.instrument(base);
  instrumentedMonitor.startSlowPatternReporter();
  return { client, monitor: instrumentedMonitor };
}

/** Record a high-level service operation duration for the query performance report. */
export function recordQueryMetric(timeOperation: string, durationMs: number): void {
  const monitorInstance = getPrismaPerformanceMonitor();
  const stats = (monitorInstance as unknown as {
    operations: Map<string, PrismaOperationStats>;
  }).operations;
  const existing = stats.get(timeOperation) ?? {
    count: 0,
    errors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    slowQueries: 0,
    rows: 0,
  };
  existing.count += 1;
  existing.totalDurationMs += durationMs;
  existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
  if (durationMs >= monitorInstance.slowQueryThresholdMs) {
    existing.slowQueries += 1;
  }
  stats.set(timeOperation, existing);
}

/** Record a cache hit/miss from a service-level cache lookup. */
export function recordCacheMetric(operation: string, hit: boolean): void {
  const monitorInstance = getPrismaPerformanceMonitor();
  const stats = (monitorInstance as unknown as {
    operations: Map<string, PrismaOperationStats>;
  }).operations;
  const existing = stats.get(operation) ?? {
    count: 0,
    errors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    slowQueries: 0,
    rows: 0,
  };
  if (hit) {
    existing.cacheHits += 1;
  } else {
    existing.cacheMisses += 1;
  }
  stats.set(operation, existing);
}

/** Alias for recordQueryMetric used by services that time their own DB calls. */
export const recordQueryTiming = recordQueryMetric;
