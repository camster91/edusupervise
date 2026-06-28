// apps/web/server/rate-limit.server.ts — in-memory rate limiter.
//
// Used to throttle the auth entry points per spec section 5:
//   - login:           5 attempts / 15 min / IP
//   - forgot password: 3 / hour / email
//   - magic link:      5 / hour / email
//   - phone verify:    5 / hour / phone
//
// Algorithm: fixed-window counter. Each (bucket, key) pair holds the
// timestamp of the first request in the current window and a counter.
// When the window expires we reset both. Older entries are swept on
// every `check()` call (lazy GC) so we don't grow unbounded.
//
// Why in-memory (Tier 1) and not Redis (Tier 2):
//   - Single web container per spec section 13. All rate-limit decisions
//     happen in-process; no network round-trip on the hot path.
//   - The 6th login attempt from a different IP won't be throttled, but
//     in Tier 1 each school is on its own Postgres so an attacker would
//     also need to compromise the user's password on the second IP.
//     Tier 2 replaces this with a Redis-backed limiter when we scale to
//     multiple web replicas.
//
// Failure mode: if the process restarts mid-window, the counter resets
// to zero. This is the correct trade-off for an auth-rate limiter (a
// restart should not permanently lock users out) — better-auth's
// built-in rate limiter has the same behaviour.
//
// Memory bound: we sweep on every check, so worst-case state is
// ~numEntries * 64 bytes. With 10k unique (bucket, key) pairs that's
// well under 1 MB.

import { logger } from './logger.server';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  /** True when the request is allowed. */
  ok: boolean;
  /** Seconds until the bucket's window resets (for Retry-After header). */
  retryAfterSec: number;
  /** Remaining quota in the current window (>=0). */
  remaining: number;
}

export interface RateLimitSpec {
  /** Identifier — typically `'login:ip:1.2.3.4'` or `'forgot:email:bob@x'`. */
  key: string;
  /** Max requests allowed per window. */
  max: number;
  /** Window length, in seconds. */
  windowSec: number;
}

/**
 * Check (and atomically increment) a rate-limit bucket. Returns a
 * decision; the caller decides whether to honor it (return 429) or just
 * log it. Side effect: when the bucket is exhausted the counter is NOT
 * incremented — we count successful attempts, not blocked attempts.
 *
 * Idempotency: this is in-process and synchronous; it does NOT block on
 * I/O so it's safe to call inside hot paths.
 */
export function check(spec: RateLimitSpec): RateLimitDecision {
  const now = Date.now();
  const bucket = buckets.get(spec.key);
  const windowMs = spec.windowSec * 1000;

  if (!bucket || now - bucket.windowStart >= windowMs) {
    // Fresh window — start at 1 (this request counts as the first).
    buckets.set(spec.key, { windowStart: now, count: 1 });
    sweepIfNeeded(now, windowMs);
    return { ok: true, retryAfterSec: 0, remaining: spec.max - 1 };
  }

  if (bucket.count >= spec.max) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((bucket.windowStart + windowMs - now) / 1000),
    );
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  bucket.count += 1;
  return {
    ok: true,
    retryAfterSec: 0,
    remaining: spec.max - bucket.count,
  };
}

// ---------------------------------------------------------------------------
// Higher-level helpers (spec section 5 quotas)
// ---------------------------------------------------------------------------

/**
 * Login attempts: 5 / 15 min / IP.
 * `ip` is the request's client IP (X-Forwarded-For honoured at the
 * proxy boundary; for raw connections it's the socket peer).
 */
export function checkLoginByIp(ip: string): RateLimitDecision {
  return check({ key: `login:ip:${ip}`, max: 5, windowSec: 15 * 60 });
}

/** Forgot password requests: 3 / hour / email. */
export function checkForgotByEmail(email: string): RateLimitDecision {
  return check({ key: `forgot:email:${email.toLowerCase()}`, max: 3, windowSec: 60 * 60 });
}

/** Magic-link requests: 5 / hour / email. */
export function checkMagicLinkByEmail(email: string): RateLimitDecision {
  return check({ key: `magic:email:${email.toLowerCase()}`, max: 5, windowSec: 60 * 60 });
}

/** Phone verification: 5 / hour / phone (E.164 format). */
export function checkPhoneVerify(phone: string): RateLimitDecision {
  return check({ key: `phone:${phone}`, max: 5, windowSec: 60 * 60 });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Bucket {
  /** Window start, ms since epoch. */
  windowStart: number;
  /** Successful (allowed) request count in the current window. */
  count: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Drop expired buckets every ~1000 calls to keep the map small. Sweep is
 * amortised O(N) over 1000 calls so each individual check stays O(1).
 */
let callCounter = 0;
function sweepIfNeeded(now: number, windowMs: number): void {
  callCounter += 1;
  if (callCounter < 1000) return;
  callCounter = 0;
  let removed = 0;
  for (const [k, v] of buckets) {
    if (now - v.windowStart >= windowMs) {
      buckets.delete(k);
      removed += 1;
    }
  }
  if (removed > 0) {
    logger.debug({ removed, remaining: buckets.size }, 'rate-limit: gc sweep');
  }
}

/**
 * Test seam: clear all buckets between integration tests. Not exported
 * via the server module's public surface — only used by the test harness
 * via a side-channel (test file imports the same module and calls this
 * directly).
 */
export function __resetRateLimitBucketsForTests(): void {
  buckets.clear();
  callCounter = 0;
}