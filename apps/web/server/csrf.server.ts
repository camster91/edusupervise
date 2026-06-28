// apps/web/server/csrf.server.ts — minimal CSRF guard for state-changing
// requests.
//
// Strategy: check that the Origin (or Referer) header of a non-GET
// request matches the host the server is configured for. This is the
// simplest defense that blocks cross-origin form submissions without
// requiring a CSRF token round-trip in every request.
//
// Limitations (acceptable for this Tier 2 task):
//   - Modern browsers always send Origin on cross-origin POST / PUT /
//     DELETE. Older browsers (IE11, some legacy mobile WebViews) only
//     send Referer — we fall back to that, then to nothing.
//   - For development on `localhost:3000` we allow `http://localhost:*`
//     since the dev server might run on a different port than production.
//
// TODO(auth-and-rls): this file is intentionally minimal. The auth-and-rls
// task adds a per-session double-submit token (CSRF cookie + header)
// that is the production-grade defense — this Origin check stays as
// a first line of defense in addition to that token.

export interface CsrfOptions {
  /**
   * Allowed hostnames. If omitted, defaults to:
   *   - process.env.APP_URL host (if set)
   *   - the `Host` request header (for dev / single-domain deploys)
   * Plus `localhost` / `127.0.0.1` for local development.
   */
  allowedHosts?: string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Validate the CSRF guard for a Request. Returns either
 *   { ok: true }                         — request may proceed
 *   { ok: false, response: Response }    — caller should `return` the response
 *
 * The returned Response is a 403 with a small JSON body — RR7 routes
 * propagate it to the client as-is.
 */
export function validateCsrf(
  request: Request,
  options: CsrfOptions = {},
):
  | { ok: true }
  | { ok: false; response: Response } {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host') ?? '';

  // 1. Origin match (preferred).
  if (origin) {
    if (originMatches(origin, host, options.allowedHosts)) {
      return { ok: true };
    }
  } else if (referer) {
    // 2. Referer match — some browsers / proxied clients strip Origin.
    if (refererMatches(referer, host, options.allowedHosts)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'csrf_failed', detail: 'origin_mismatch' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  };
}

function originMatches(
  origin: string,
  host: string,
  allowed: ReadonlyArray<string> | undefined,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return hostMatches(parsed.host, host, allowed);
}

function refererMatches(
  referer: string,
  host: string,
  allowed: ReadonlyArray<string> | undefined,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return false;
  }
  return hostMatches(parsed.host, host, allowed);
}

function hostMatches(
  candidateHost: string,
  requestHost: string,
  allowed: ReadonlyArray<string> | undefined,
): boolean {
  // Exact match against the request's Host header is the strongest signal.
  if (candidateHost === requestHost) return true;

  // Env-configured APP_URL host always allowed.
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      if (new URL(appUrl).host === candidateHost) return true;
    } catch {
      // ignore malformed APP_URL
    }
  }

  // Explicit allow-list.
  if (allowed?.includes(candidateHost)) return true;

  // Localhost variants for dev.
  if (
    candidateHost.startsWith('localhost:') ||
    candidateHost.startsWith('127.0.0.1:') ||
    candidateHost === 'localhost' ||
    candidateHost === '127.0.0.1'
  ) {
    return true;
  }

  return false;
}