// apps/web/server/client-ip.server.ts — safe client-IP extraction.
//
// BACKGROUND (audit S-S2, 2026-07-04):
//
// X-Forwarded-For (XFF) is the standard HTTP header for communicating
// the original client IP behind a reverse proxy. The catch: ANY caller
// can SET XFF on a direct request. If we read XFF without verifying the
// request came from a trusted proxy, an attacker can:
//
//   - Spoof XFF: "X-Forwarded-For: 1.2.3.4"  → our rate-limiter keys
//     every request to a fresh bucket, evading the per-IP throttle.
//   - Hide from logs: the audit_log.ipAddress column would show the
//     spoofed value, not the real attacker IP.
//
// PRODUCTION DEPLOYMENT:
//
//   - Traefik is the SOLE ingress for this app (docker/docker-compose.yml,
//     edge router, ports 80/443 → 3011). It sets XFF on every request
//     it forwards to the web container.
//   - The web container has no public port — Traefik talks to it over
//     the internal Docker network.
//   - Therefore, on every production request, the socket peer is the
//     Traefik container, NOT the real client.
//
// HOW TO BEHAVE:
//
//   - When TRUST_PROXY=1 is set (Traefik / any trusted reverse proxy is
//     upstream), trust the LEFTMOST XFF entry (= the original client
//     per RFC 7239). The docker-compose.yml sets TRUST_PROXY=1 on the
//     web service.
//   - When TRUST_PROXY is unset/0, do NOT trust XFF — fall back to
//     'unknown'. RR7's Request type does not expose the socket peer
//     address, so we cannot do better than 'unknown' from inside the
//     handler. Direct connections in dev are still rate-limited; they
//     just share the 'unknown' bucket (acceptable for a dev box).
//
// This helper is the single read site for client IP — every caller in
// apps/web/{app,server} must use it, never read XFF directly.

/**
 * Cached once at module load. We snapshot the env var because:
 *   (a) tests can flip it via `process.env.TRUST_PROXY = ...`,
 *   (b) reading the env on every request would be slow at scale.
 */
const TRUST_PROXY: boolean = process.env.TRUST_PROXY === '1';

/**
 * Extract the best-effort client IP for a Request.
 *
 * Returns:
 *   - LEFTMOST XFF entry (after trim) when TRUST_PROXY=1
 *   - the X-Real-IP header when present (set by some proxies as an
 *     alternative to XFF) and TRUST_PROXY=1
 *   - 'unknown' otherwise — no socket access in RR7, no env trust
 *
 * Never returns null/undefined so callers can use it as a Map key
 * without special-casing. Returns 'unknown' (string) as the sentinel.
 */
export function clientIp(request: Request): string {
  if (!TRUST_PROXY) return 'unknown';

  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  return 'unknown';
}

/**
 * Returns the current trust-proxy mode. Exposed for tests + the
 * /api/health endpoint so an operator can confirm at a glance.
 */
export function isTrustProxyEnabled(): boolean {
  return TRUST_PROXY;
}