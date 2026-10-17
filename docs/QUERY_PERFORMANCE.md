# Query Performance

Issue #12. Companion document to [INDEXING.md](./INDEXING.md) (index layout) and
[PAGINATION.md](./PAGINATION.md) (result-size limits).

## What is instrumented

### Prisma (the ORM)

`src/db/prisma-performance.ts` wraps the client in a Prisma query extension
`$extends`) that is installed once, in `src/index.ts`:

```ts
const { client, monitor } = createInstrumentedPrismaClient();
```

Every operation — reads and writes, on every model — then records:

| Signal | Where it goes |
|--------|--------------|
| duration, per `Model.operation` | `dorisio_prisma_query_duration_seconds` histogram, `PrismaPerformanceMonitor.getStats()` |
| call/error counts | `dorisio_prisma_query_count_total`, `stats.operations[key].errors` |
| rows returned | `dorisio_prisma_query_rows` histogram |
| slow queries | `dorisio_prisma_slow_queries_total`, `monitor.getSlowQueries()` |
| read-cache hits/misses | `dorisio_prisma_cache_hits_total` / `dorisio_prisma_cache_misses_total` |
| list reads without `take` | `dorisio_prisma_unbounded_reads_total` |

Because the extension is a client-level concern rather than a service concern,
new code gets instrumentation without having to remember it.

### Raw SQL pool (`pg`)

`src/db/connection.ts` keeps a separate `pg` pool. Its `query()` helper goes
through `QueryCache` + `QueryLogger` (`src/db/query-cache.ts`,
`src/db/query-logger.ts`) with the same guarantees: statements are fingerprinted
by `normalizeSql()` (literals → placeholders) so metrics and slow-query grouping
stay at constant cardinality, and parameters are redacted and truncated before
they reach a log line.

## Read cache

Short-lived, deliberately conservative:

| Setting | Env var | Default |
|---------|---------|---------|
| enabled | `DB_QUERY_CACHE_ENABLED` | `true` |
| TTL | `DB_QUERY_CACHE_TTL_MS` | `60000` |
| hard TTL ceiling | `DB_QUERY_CACHE_MAX_TTL_MS` | `300000` |
| max entries | `DB_QUERY_CACHE_MAX_ENTRIES` | `500` |

Rules the implementation enforces:

1. **Writes are never cached** — only `findUnique`, `findFirst`, `findMany`,
   `count`, `aggregate` and `groupBy` are eligible, and the raw-SQL path refuses
   anything that is not read-only (`isReadOnlyQuery()`).
2. **A write invalidates the whole model** (`model:Tip` → drop every cached
   `Tip.*` read) in a `finally`, so a failed write cannot leave stale rows
   cached either.
3. **Projections that touch credentials or signing material are never cached**
   (`password`, `secretKey`, `apiKey`, … at any nesting depth) — the process
   cache must not become a credential store.
4. **A cached `null` is a hit, not a miss.** `lookup()`/`peek()` return
   `{ hit, value }` so "no rows" is not re-queried on every request.
5. **Single-flight**: concurrent misses for one key share one loader
   (`getOrLoad`), so a cold cache does not turn into a thundering herd.
6. **TTL is clamped** to the configured maximum, whatever a caller asks for.

## Unbounded and N+1 reads

* List reads without `take` are counted and warned about (throttled to one log
  line per minute per model) by the monitor — the query still runs, so this is a
  signal, not a hard failure.
* Hot paths were converted to bounded reads:
  * `getTopCreators` / `getTopSupporters` use `groupBy` + `take` + an aggregate
    instead of loading rows to sort them in Node.
  * Earnings-over-time is bucketed with `date_trunc` in SQL
    (`$queryRaw`) instead of fetching every tip.
  * `listWebhooks` is paginated; webhook dispatch fans out over at most
    `MAX_DISPATCH_TARGETS = 50` targets per event.
  * Wallet reads are projected and capped at 20 rows per user.
* Full-table `findMany` followed by arithmetic in JS became `aggregate`
  (`_sum`/`_count`) in `creators/analytics.service.ts`.

## N+1 sweep

Every remaining `findMany` in `src/` is paginated, capped or a bounded
0 per-parent lookup, and relation payloads use `select` instead of `include` where
only a few columns are needed (`TIP_RESPONSE_SELECT`, `WEBHOOK_EVENT_SELECT`,
``CREATOR_PROFILE_SELECT`, `USER_PROFILE_SELECT`, `CREATOR_SELECT`,
``TIP_SELECT`, `USER_SELECT` — see the constants in `src/db/selects.ts`).

One loop that remains is intentional: webhook dispatch `Promise.all`s over the
event's targets. It is bounded, and the targets are needed independently.

## Projections

List and detail reads project only the fields the API returns. Notable
consequence: `WebhookEvent` reads exclude `payload`, which is the largest column
in the table and is only needed by the delivery worker.

## Diagnostics endpoints

```
GET  /diagnostics/queries/performance   # aggregated stats + recent slow queries
POST /diagnostics/queries/explain       # EXPLAIN (FORMAT JSON) for a SELECT
```

The explain endpoint validates its body with Zod and rejects anything that is not
read-only before it reaches the database:

```bash
curl -s -X POST localhost:3000/diagnostics/queries/explain \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM \"Tip\" WHERE \"creatorId\" = $1","params":["<id>"],"buffers":true}'
```

[`"{\"analyze\": true} prefixes the statement with `EXPLAIN ANALYZE`, which
**executes** it — that is why it is opt-in.

Both endpoints, plus the `query_performance` block in `GET /health` and
GET /metrics/json`, read the shared monitor. If a cache ever needs to be
invalidated by hand, `POST /cache/invalidate` still works as before.

## Slow-query triage

1. `GET /metrics/json` → `query_performance` (per-operation p99-like max, error
   counts, cache hit rate, unbounded reads).
2. `GET /diagnostics/queries/performance` → `slowQueries[]`, newest first, with
   fingerprint, duration, row count and timestamp.
3. Reproduce the fingerprint with `POST /diagnostics/queries/explain` and read
   `indexNames` / `sequentialScans` / `recommendations`.
4. If a recommendation is "row estimates differ significantly", run
   `ANALYZE` on the table — the new migration already runs `ANALYZE` for the
   tables it touches, but statistics drift as data grows.
5. If a query is hot but legitimately read-mostly, raise `DB_QUERY_CACHE_TTL_MS`
   before reaching for a replica.

Threshold: `DB_SLOW_QUERY_THRESHOLD_MS` (default 200). A statement at or above
it is logged at `warn` and kept in the in-memory history (100 entries, ring
buffer).

## Health and metrics exposure

The shared monitor is surfaced in two places so contributors and operators can
see cache effectiveness and slow-query pressure without reaching for a log grep.

### `GET /health`

The health response includes a `query_performance` block derived from
`PrismaPerformanceMonitor.getStats()`:

```json
{
  "status": "ok",
  "query_performance": {
    "cache": {
      "hits": 12840,
      "misses": 215,
      "hitRate": 0.9835,
      "entries": 312,
      "evictions": 4
    },
    "slowQueryCount": 7,
    "slowQueryThresholdMs": 200,
    "unboundedReads": 0,
    "operations": {
      "Tip.findMany": { "count": 921, "errors": 0, "maxMs": 184, "p99Ms": 120 },
      "Creator.findUnique": { "count": 4402, "errors": 0, "maxMs": 41, "p99Ms": 22 }
    }
  }
}
```

A non-zero `slowQueryCount` or a `hitRate` that collapses towards zero is
the signal to start the triage checklist below. The block is cheap to compute (it
is in-memory counters) and never hits the database.

### `GET /metrics/json`

Same structure, plus the Prometheus-style counters and histograms listed in
the instrumentation table above. This is the path to scrape if you are building
dashboards around cache hit rate and slow-query counts.

## Optimized Prisma patterns in the backend

These are the patterns to copy when adding a new query. Each one has a
measurable effect on the metrics above.

### 1. Project with `select` instead of `include`

When a list endpoint only needs a few columns, `select` keeps the row count
small and avoids fetching the large payload columns (e.g. `WebhookEvent.payload`).

```ts
const TIP_SELECT = {
  id: true,
  amount: true,
  createdAt: true,
  creator: { select: { id: true, username: true } },
  media: { select: { id: true, url: true } },
} as const;

const tips = await prisma.tip.findMany({
  where: { creatorId },
  select: TIP_SELECT,
  take: pageSize,
  orderBy: { createdAt: "desc" },
});
```

### 2. Paginate every list read

Always pass `take` (and `skip` for offset pages). The monitor counts any
`findMany` without `take` as an unbounded read and logs a throttled warning.

```ts
await prisma.tip.findMany({
  where: { creatorId },
  select: TIP_SELECT,
  take: Math.min(pageSize, MAX_PAGE_SIZE),
  skip: offset,
  orderBy: { createdAt: "desc" },
});
```

### 3. Aggregate in the database, not in Node

For totals and counts, use `aggregate` / `groupBy` so the database returns
one row instead of every tip:

```ts
const totals = await prisma.tip.aggregate({
  where: { creatorId },
  _sum: { amount: true },
  _count: true,
});
```

For top-creator / top-supporter rankings, `groupBy` + `take` lets the
database do the sorting and truncation:

```ts
const top = await prisma.tip.groupBy({
  by: ["creatorId"],
  _sum: { amount: true },
  orderBy: { _sum: { amount: "desc" } },
  take: 10,
});
```

### 4. Bucket time series in SQL 

Earnings-over-time reads use `date_trunc` via `$queryRaw` instead of
fetching every tip and bucketing in JavaScript:

```ts
const buckets = await prisma.$queryRaw`
  SELECT date_trunc('day', "createdAt") AS day, SUM("amount") AS total
  FROM "Tip"
  WHERE "creatorId" = ${creatorId}
    AND "createdAt" >= ${since}
  GROUP BY 1
  ORDER BY 1;
```

### 5. Cap per-parent lookups

When a request needs related rows for a small set of parents, fetch them in
one query with an `in` instead of one query per parent (the classic N+1
pattern):

```ts
const wallets = await prisma.wallet.findMany({
  where: { userId: { in: userIds } },
  select: { id: true, userId: true, address: true },
  take: userIds.length * 20,
});
```

### 6. Let the cache do its job

Read-only lookups on slow-moving data (creator profiles, webhook configs)
benefit from the read cache without any code change. Do not add a manual
cache on top of it — just keep the query read-only and projected, and the
extension will cache it. Writes invalidate the model automatically.

## Top slow query patterns (production-like run)

The following three patterns are the highest-cost queries observed in a
production-like test run (seeded dataset, cold cache, `slowQueryThresholdMs` =
200). They are listed here so contributors can match a log line or a
`slowQueries[]` entry to a known pattern and the fix that already exists.

| # | Pattern (fingerprint) | Why it was slow | Fix in place |
|---|-----------------------|---------------|--------------|
| 1 | `Tip.findMany` with `creatorId` + `ORDER BY createdAt DESC` | Full scan on `Tip` when the creator has many tips; sorting in Node added latency | Composite index `(creatorId, createdAt DESC)` serves the filter and the sort; query is paginated with `take` and projected with `TIP_SELECT` |
| 2 | `Tip.groupBy` by `creatorId` with `_sum.amount` | Aggregating every tip row for top-creator rankings without an index on the group key | Index on `Tip.creatorId` + `take` so the database sorts and truncates; replaced the old fetch-all-then-sort-in-JS path |
| 3 | `Wallet.findMany` by `userId`, in a per-user loop | N+1: one query per user when listing wallets | Single `in` query with `take` capped at 20 rows per user and a projection that drops unused columns |

To reproduce this list on a fresh database, run the seed and test suite, then
read `GET /diagnostics/queries/performance`; the `slowQueries[]` array is ordered
newest-first and each entry carries the fingerprint that matches the table
above. The same fingerprints appear in the `slowQueryCount` and per-operation
max in `GET /health`.
