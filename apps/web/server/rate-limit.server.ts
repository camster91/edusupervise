// apps/web/server/rate-limit.server.ts — per-process in-memory rate limiter.
//
// Used by:
//   - /auth/login       — 5 / 15 min / IP
//   - /auth/forgot      — 3 / hour / email
//   - /auth/magic       — 5 / hour / email
//   - /auth/verify-phone — 5 / hour / phone
//
// Why per-process:
//   - Single web container behind a sticky load balancer is the Tier 1
//     deployment. The map lives in process memory and resets on restart.
//   - For multi-instance deployments (Tier 2) this MUST be replaced with a
//     Redis-backed implementation. See note below.
//
// Why a sliding window (not fixed bucket):
//   - A sliding window prevents bursts at the boundary of two fixed
//     windows (e.g. 5 attempts at 14:59 then 5 more at 15:00 = 10 in
//     2 minutes). Each call to `consume` evicts entries older than
//     `windowMs` from the key's history.
//
// Why NOT the well-known `rate-limiter-flexible` npm package:
//   - Adds a dependency for ~80 lines of code. The behavior we need
//     (in-memory sliding window, named buckets, single-call API) fits
//     in this file cleanly and keeps the cold-load cost of the auth
//     path minimal.

export interface RateLimitConfig {
  /** Max number of allowed events per window. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** True if the event is allowed, false if it was rate-limited. */
  allowed: boolean;
  /** How many events remain in the current window after this call. */
  remaining: number;
  /** Seconds until the oldest event in the window expires (for Retry-After). */
  retryAfterSeconds: number;
  /** Total events counted in the current window (after this call). */
  count: number;
}

export type RateLimitBucket =
  | 'login'
  | 'forgot'
  | 'magic'
  | 'verify-phone';

// Default windows per spec section 5.
export const RATE_LIMITS: Record<RateLimitBucket, RateLimitConfig> = {
  login: { max: 5, windowMs: 15 * 60 * 1000 }, // 5 / 15 min
  forgot: { max: 3, windowMs: 60 * 60 * 1000 }, // 3 / hour
  magic: { max: 5, windowMs: 60 * 60 * 1000 }, // 5 / hour
  'verify-phone': { max: 5, windowMs: 60 * 60 * 1000 }, // 5 / hour
};

interface BucketState {
  /** Timestamps of recent events, oldest first. Pruned on each call. */
  hits: number[];
}

/**
 * The store is module-scoped. One map per (bucket, key) tuple. Keys are
 * either IPs (`login`) or identifiers (`forgot` / `magic` /
 * `verify-phone`). Maps are typed as `Map<string, BucketState>` for
 * O(1) access.
 */
const store: Map<string, BucketState> = (() => {
  // Using a global Map ensures the same in-memory store across module
  // reloads (vitest's watch mode re-evaluates modules; we want rate-limit
  // state to persist within a single test run).
  const g = globalThis as unknown as { __rateLimitStore?: Map<string, BucketState> };
  if (!g.__rateLimitStore) g.__rateLimitStore = new Map();
  return g.__rateLimitStore;
})();

/**
 * Record one event for `(bucket, key)` and report whether it's allowed.
 *
 * Algorithm: sliding window.
 *   1. Look up the bucket's hit history (an array of millisecond timestamps).
 *   2. Drop entries older than `now - windowMs`.
 *   3. If `hits.length >= max`, reject.
 *   4. Otherwise push `now` and accept.
 *
 * This is O(window) per call (worst case ~5 hits / 15min = trivial).
 */
export function consume(
  bucket: RateLimitBucket,
  key: string,
  config: RateLimitConfig = RATE_LIMITS[bucket],
  now: number = Date.now(),
): RateLimitResult {
  const fullKey = `${bucket}:${key}`;
  let state = store.get(fullKey);
  if (!state) {
    state = { hits: [] };
    store.set(fullKey, state);
  }

  // Drop expired entries.
  const cutoff = now - config.windowMs;
  while (state.hits.length > 0 && state.hits[0]! < cutoff) {
    state.hits.shift();
  }

  if (state.hits.length >= config.max) {
    const oldest = state.hits[0]!;
    const retryAfterMs = oldest + config.windowMs - now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      count: state.hits.length,
    };
  }

  state.hits.push(now);
  return {
    allowed: true,
    remaining: config.max - state.hits.length,
    retryAfterSeconds: 0,
    count: state.hits.length,
  };
}

/**
 * Reset a single bucket (used by tests; production code should not call).
 */
export function _resetBucket(bucket: RateLimitBucket, key: string): void {
  store.delete(`${bucket}:${key}`);
}

/**
 * Reset the entire store (used by tests).
 */
export function _resetAll(): void {
  store.clear();
}

/**
 * Build a 429 Response with a `Retry-After` header (in seconds).
 */
export function buildRateLimitedResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'rate_limited',
      detail: 'too_many_requests',
      retryAfterSeconds: result.retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(result.retryAfterSeconds),
      },
    },
  );
}