// apps/web/server/metrics.server.ts — Prometheus instrumentation.
//
// Exposes a single shared `prom-client` Registry scoped to this Node
// process. Sibling modules (`entry.server.tsx`, routes/metrics.tsx,
// backup gauge) import `registry`, `httpDuration`, `httpRequestsTotal`,
// `dbPoolConnections`, and `backupLastSuccessGauge` directly — keeping
// the surface small enough to grep.
//
// Why a registry (not the shared default):
//   - `prom-client` ships a global default registry. Tests + scripts
//     import the package once and the default collects Node metrics
//     automatically. For the live web process we want explicit control:
//     none of the default metrics (gc, heap) are noisy at our scale;
//     `collectDefaultMetrics({ register: registry, prefix: 'edusupervise_' })`
//     keeps the namespacing clean.
//   - Multiple registries would double-count if two consumers
//     independently pulled Node's runtime stats.
//
// What lives here (audit slice-5 B10):
//   - `http_request_duration_seconds`  histogram — count + sum + buckets.
//   - `http_requests_total`            counter  — total reqs by method+path+status.
//   - `process_cpu_seconds_total`      default Node metric.
//   - `process_resident_memory_bytes`  default Node metric.
//   - `db_pool_connections`            gauge    — open Drizzle clients.
//   - `backup_last_success_timestamp_seconds` gauge — updated by backup.sh.
//
// Histogram path label is the ROUTE pattern (e.g. `app/today`), NOT the
// raw URL — raw URLs include IDs and would explode the label set on a
// /app/duties/:id route. The route pattern lives on the per-request
// record that `entry.server.tsx` writes onto `request.headers`.

import client, { type Registry } from 'prom-client';

export const registry: Registry = new client.Registry();

// Scrape-friendly labels: prefix matches our service name so a scraper
// can group metrics from sibling services later without collisions.
registry.setDefaultLabels({ service: 'edusupervise-web' });

// Default Node metrics — process_cpu_seconds_total,
// process_resident_memory_bytes, nodejs_eventloop_lag_seconds, etc.
// Cheap to collect; useful for the OOMKill / swap-thrash alert path.
client.collectDefaultMetrics({ register: registry, prefix: 'edusupervise_' });

// HTTP request latency histogram. Buckets cover 5ms (cached static) up
// to 10s (pathological SSR); finer-grained under 1s where the median
// typically lives.
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// HTTP request counter — same labels as the histogram so a PromQL
// `rate(...)` over the histogram count equals the per-bucket sum.
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'path', 'status_code'] as const,
  registers: [registry],
});

// Open-Drizzle-client gauge. `withSchoolId` opens a tx; `getSystemClient`
// hands a long-lived pool to the worker. We can't introspect "active"
// clients cheaply across both paths without a wrapper, so we count the
// pool we'd currently open: 1 for the runtime singleton from `getDb()`,
// 1 each for any system-client the worker has live. On the web
// container only the singleton is real; system-client is for parity
// (the /metrics route runs in web, so this gauge only counts what web
// knows about).
export const dbPoolConnections = new client.Gauge({
  name: 'db_pool_connections',
  help: 'Currently-open Drizzle/Postgres clients',
  labelNames: ['role'] as const,
  registers: [registry],
});

// Backup freshness gauge. Set externally by `backup.sh` writing a
// timestamp to /var/lib/node_exporter/edusupervise_backup_last_success
// (the file path matches Prometheus text-collector convention so a
// second textfile collector can pick it up). We also expose a setter
// for tests + the post-deploy smoke run.
export const backupLastSuccessGauge = new client.Gauge({
  name: 'backup_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful DB backup',
  registers: [registry],
});

/** Record one HTTP request. Called from entry.server.tsx on `onShellReady`. */
export function recordHttpRequest(
  method: string,
  path: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const labels = {
    method,
    path,
    // Prometheus convention: status_code as a string label.
    status_code: String(statusCode),
  };
  httpDuration.observe(labels, durationSeconds);
  httpRequestsTotal.inc(labels, 1);
}

/** Update the backup gauge (called once per process boot from routes/metrics). */
export function setBackupLastSuccess(unixSeconds: number): void {
  backupLastSuccessGauge.set(unixSeconds);
}

// ---------------------------------------------------------------------------
// Path-label normalizer
// ---------------------------------------------------------------------------

/**
 * Map a raw request pathname to a Prometheus label value.
 *
 * Why we don't label by raw pathname: a route like
 * `app/duties/:id` would explode the label set (one bucket per duty).
 * RR7 stores the matched route pattern on the route's match data,
 * but at the entry.server.tsx level we only have the URL — so we
 * apply a small set of regex normalizations that cover the routes
 * that take path parameters.
 *
 * Unknown paths map to `other` so the label cardinality stays bounded.
 */
export function routePatternFor(pathname: string): string {
  // Health probes: bucket together for low-cardinality alerting.
  if (pathname === '/healthz' || pathname === '/health') return 'healthz';
  // Path-parameterized routes.
  if (/^\/app\/duties\/[^/]+\/?$/.test(pathname)) return 'app/duties/:id';
  // Static-ish top-level route groups.
  // Strip query before labeling (Prometheus labels disallow '?')
  // and trailing slash, then canonicalize one common empty form.
  const stripped = (pathname.split('?')[0] ?? pathname).replace(/\/$/, '') || '/';
  // Path-parameterized routes — bucket all dynamic params under :id
  // so per-resource fetches don't explode cardinality.
  if (/^\/app\/duties\/[^/]+$/.test(stripped)) return 'app/duties/:id';
  // Top-level route groups — start with an allowlist of the
  // bare paths we actually serve (registration routes, auth,
  // health probes, favicon). Anything we haven't seen falls back
  // to 'other' to keep cardinality bounded.
  const topLevel = new Set([
    '/',
    '/signup',
    '/login',
    '/logout',
    '/forgot',
    '/reset',
    '/verify-email',
    '/verify-phone',
    '/auth/magic',
    '/healthz',
    '/health',
    '/metrics',
    '/favicon.ico',
  ]);
  if (topLevel.has(stripped)) return stripped;
  if (stripped.startsWith('/app/')) return stripped;
  if (stripped.startsWith('/api/')) return stripped;
  if (stripped.startsWith('/onboarding/')) return stripped;
  return 'other';
}

/**
 * Update the db-pool gauge. Called once on process boot from the
 * web entry; intended to be re-callable so a future withSchool
 * wrapper can `inc`/`dec` around tx lifetimes if we ever need it.
 */
export function setDbPoolCount(role: 'runtime' | 'system', count: number): void {
  dbPoolConnections.set({ role }, count);
}
