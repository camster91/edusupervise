// apps/web/server/csrf.server.ts — double-submit cookie CSRF guard.
//
// Strategy (spec section 5):
//   1. On every GET request, if the `__Host-edusupervise.csrf` cookie is
//      missing, mint a fresh 32-byte base64url token and set the cookie
//      via `Set-Cookie` on the response. The cookie is HttpOnly=false so
//      the browser can read it via `document.cookie` and re-send it on
//      every mutation.
//   2. On every non-safe (POST/PUT/PATCH/DELETE) request, compare the
//      `x-csrf-token` header (or `csrf` form body field) to the cookie
//      value using `crypto.timingSafeEqual` — constant-time compare so
//      attackers can't observe the comparison latency.
//   3. On login success, rotate the CSRF token (mint a new one and reset
//      the cookie). The previous token becomes invalid — defends against
//      a stolen cookie pair being used post-authentication.
//
// `__Host-` prefix requirements:
//   - `Secure` attribute (HTTPS-only)
//   - `Path=/`
//   - No `Domain` attribute (host-locked)
//   Browsers reject the cookie at Set-Cookie if any of these are missing.
//
// Why we ALSO keep the Origin check:
//   - The Origin check is the FIRST line of defense; it rejects obvious
//     cross-origin form POSTs without us having to read any cookie. The
//     double-submit cookie is the SECOND line that catches more subtle
//     attacks (e.g. sub-domain takeover, browser extension that can read
//     cookies on a same-origin page).
//
// Rate-limit interaction:
//   - The CSRF guard runs BEFORE the route action's business logic, so a
//     403 here counts toward the per-IP login rate limit (5 / 15min).
//     Without that ordering, an attacker could grind on login attempts
//     with a malformed CSRF token and never trip the limiter.
//
// Why `crypto.timingSafeEqual` and not `===`:
//   - `===` short-circuits on the first byte mismatch, leaking token
//     bytes via response-time analysis. `timingSafeEqual` always runs
//     the full comparison. We pre-check the lengths are equal so it
//     doesn't throw.

import { timingSafeEqual, randomBytes } from 'node:crypto';

import { logger } from './logger.server';

export interface CsrfOptions {
  /**
   * Allowed origin / referer hostnames. If omitted, the validator falls
   * back to `APP_URL` from env, then to the request's `Host` header.
   * Localhost variants are always allowed in dev.
   */
  allowedHosts?: string[];
  /**
   * When true, mints a new CSRF token and attaches it to the response's
   * Set-Cookie header. Routes call this from their GET loader.
   */
  rotateCookie?: boolean;
  /**
   * When true (the default for web routes), the request MUST carry an
   * Origin header. Requests with no Origin at all are rejected.
   *
   * The native mobile app sends literal `Origin: null` (RFC 6454 §7),
   * which still satisfies the Layer-1 origin match. Set this to `false`
   * only for the `api.mobile.push.*` routes that are explicitly
   * designed for native clients where the cookie-binding defense
   * (Layer 2) is the only signal that matters.
   *
   * Audit 2026-07-22 P2-1: without this gate, a non-browser client
   * (XHR from same-origin XSS, a curl that knows the cookie, or a
   * native agent that omits Origin) can satisfy Layer 2 with a stolen
   * cookie and bypass Layer 1 entirely.
   */
  requireOrigin?: boolean;
}

/**
 * Default for web routes — Origin MUST be present.
 * Set `false` only on the mobile-push routes (see CsrfOptions.requireOrigin).
 */
const DEFAULT_REQUIRE_ORIGIN = true;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cookie name required by spec section 5. */
export const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';

/** Field name read from form bodies (RR7 actions submit FormData). */
export const CSRF_FORM_FIELD = 'csrf';

/** Header name that carries the token on JSON/fetch mutations. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the CSRF guard for a Request.
 *
 * Returns:
 *   { ok: true }                          — request may proceed
 *   { ok: false, response: Response }     — caller should `return` the response
 *
 * On the success branch, the caller SHOULD subsequently call
 * `attachCsrfCookie(response)` to refresh the cookie on the way out, so
 * the next mutation has a current token. (Mutations don't refresh; we
 * only rotate on login and on the first GET of a session.)
 */
export function validateCsrf(
  request: Request,
  options: CsrfOptions = {},
):
  | { ok: true }
  | { ok: false; response: Response } {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  // Layer 1: Origin / Referer match. This is the cheap rejection for
  // obvious cross-origin POSTs — we don't even read the cookie.
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host') ?? '';
  const requireOrigin = options.requireOrigin ?? DEFAULT_REQUIRE_ORIGIN;

  // Audit 2026-07-22 P2-1: Sec-Fetch-Site is a structured-fields hint
  // that all modern browsers send on navigations + fetches. "same-origin"
  // is a stronger same-origin signal than the Origin header (which a
  // same-origin XSS payload can spoof). If the browser says
  // cross-site, we reject — before any cookie comparison.
  //
  // Non-browser clients (curl, native apps, server-to-server) don't send
  // Sec-Fetch-Site, so the check is opt-in via the header's presence.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    logger.debug({ secFetchSite }, 'csrf: sec-fetch-site cross-site');
    return forbidden('sec_fetch_site_cross_site');
  }

  if (!origin && !referer) {
    // No Origin AND no Referer: this is a same-origin request (most
    // browsers always send Origin on cross-origin; if both are absent,
    // it's either a server-to-server curl call or an old browser). We
    // still require a CSRF token to be present in this case so the
    // cookie-pair defense is not bypassable.
    //
    // Audit 2026-07-22 P2-1: web routes require Origin to be present
    // so a same-origin XSS page cannot bypass Layer-1 entirely. The
    // native mobile app's `Origin: null` still satisfies this gate
    // (see originMatches() — `null` is allowed for native).
    if (requireOrigin) {
      logger.debug('csrf: missing origin (web route requires it)');
      return forbidden('missing_origin');
    }
  } else if (origin) {
    if (!originMatches(origin, host, options.allowedHosts)) {
      logger.debug({ origin, host }, 'csrf: origin mismatch');
      return forbidden('origin_mismatch');
    }
  } else if (referer) {
    if (!refererMatches(referer, host, options.allowedHosts)) {
      logger.debug({ referer, host }, 'csrf: referer mismatch');
      return forbidden('referer_mismatch');
    }
  }

  // Layer 2: double-submit cookie. The header (or form field) must equal
  // the cookie value. We extract both first, then compare in constant time.
  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken =
    request.headers.get(CSRF_HEADER_NAME) ?? readFormBodyField(request);

  if (!cookieToken || !headerToken) {
    logger.debug(
      { hasCookie: !!cookieToken, hasHeader: !!headerToken },
      'csrf: missing token',
    );
    return forbidden('missing_token');
  }

  // timingSafeEqual requires equal-length buffers. If the lengths differ,
  // we still want to refuse, but we do so by comparing against a dummy
  // token of the same length to keep timing roughly constant.
  const a = Buffer.from(cookieToken);
  let b: Buffer;
  if (headerToken.length === a.length) {
    b = Buffer.from(headerToken);
  } else {
    // Pad / truncate to the same length so timingSafeEqual doesn't throw
    // AND so the timing matches a same-length pair.
    b = Buffer.alloc(a.length);
    Buffer.from(headerToken).copy(b, 0, 0, Math.min(a.length, headerToken.length));
  }
  if (!timingSafeEqual(a, b)) {
    logger.debug('csrf: token mismatch');
    return forbidden('token_mismatch');
  }

  return { ok: true };
}

/**
 * Read the CSRF cookie value from the request, or null if absent. The
 * client-side `app/lib/csrf.ts` helper uses this to populate the
 * `x-csrf-token` header on fetch mutations.
 */
export function readCsrfCookie(request: Request): string | null {
  return readCookie(request, CSRF_COOKIE_NAME);
}

/**
 * Build a Set-Cookie header value that clears the CSRF cookie.
 * Use this on logout and on any "session is gone" response so the
 * token doesn't outlive the session — without this, a victim's
 * double-submit token persists in `document.cookie` for the full
 * 24h TTL after logout.
 *
 * Audit 2026-07-22 P3-2.
 */
export function clearCsrfCookie(): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const parts = [
    `${CSRF_COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly=false`,
    `SameSite=Lax`,
    `Max-Age=0`,
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Mint a new CSRF token and build a Set-Cookie header value. The cookie
 * is HttpOnly=false (JS-readable), SameSite=Lax, Path=/, Secure-in-prod.
 * Returns the raw token so the caller can include it in the response body
 * (e.g. as a meta tag the client reads on first paint).
 */
export interface MintedCsrf {
  token: string;
  setCookie: string;
}

export function mintCsrfCookie(): MintedCsrf {
  const token = randomBytes(32).toString('base64url');
  const setCookie = serializeCsrfCookie(token);
  return { token, setCookie };
}

/**
 * Convenience helper: returns a Response object that sets the CSRF cookie.
 * Routes use this in their GET loader so the browser picks up the token
 * before the first mutation.
 */
export function withCsrfCookie<T extends Response>(response: T): T {
  const { setCookie } = mintCsrfCookie();
  response.headers.append('Set-Cookie', setCookie);
  return response;
}

/**
 * Read the existing CSRF cookie, or mint a fresh one. Returns both the
 * token (for embedding into rendered HTML / loader data) and a
 * `setCookie` value that the caller attaches to the response. When the
 * cookie already exists, `setCookie` is null so callers can no-op the
 * header append.
 *
 * Use from entry.server.tsx so the cookie is minted exactly once per
 * session (on the first non-asset request) rather than per-loader. This
 * eliminates the previous loader pattern that returned either a plain
 * `{ csrfToken }` object or a Response with Set-Cookie depending on
 * cookie presence — the inconsistency caused React #418/#425 hydration
 * warnings because the loader data shape changed between visits.
 */
export function ensureCsrfCookie(request: Request): {
  token: string;
  setCookie: string | null;
} {
  const existing = readCsrfCookie(request);
  if (existing) return { token: existing, setCookie: null };
  const { token, setCookie } = mintCsrfCookie();
  return { token, setCookie };
}


// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function forbidden(reason: string) {
  return {
    ok: false as const,
    response: new Response(
      JSON.stringify({ error: 'csrf_failed', detail: reason }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  };
}

/**
 * Serialize the cookie in a way that browsers accept with the `__Host-`
 * prefix. The prefix REQUIRES: Secure, Path=/, no Domain. We omit
 * `Domain` entirely (host-locked); we set Path=/ and Secure in prod; we
 * set HttpOnly=false (JS-readable for double-submit).
 *
 * In dev (http://localhost) `Secure` would cause the browser to reject
 * the cookie entirely. We omit `Secure` in dev so local development
 * works on http://. The cookie name still includes the prefix even in
 * dev — that's fine; the prefix only requires Secure to be present, not
 * that Secure be set. (In dev the cookie is otherwise meaningless since
 * it has no `Secure` flag and no `Domain`.)
 */
function serializeCsrfCookie(token: string): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    `Path=/`,
    `HttpOnly=false`,
    `SameSite=Lax`,
    `Max-Age=${60 * 60 * 24}`, // 24h — long enough for a session, short enough to expire stale tabs
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Read the cookie from the `Cookie` header. We avoid a full cookie-parser
 * dependency since we only ever need one or two named cookies per request.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const k = pair.slice(0, eqIdx).trim();
    if (k === name) return pair.slice(eqIdx + 1).trim();
  }
  return null;
}

/**
 * Read the CSRF token from the request body if it's a form submission.
 * We only attempt this when the content-type looks like a form; JSON
 * fetches always send the header instead. This is intentionally a
 * single-shot read — calling `.formData()` consumes the request body
 * and prevents later handlers from re-parsing it, so routes that need
 * both CSRF validation AND body parsing should pass the parsed form
 * through this function.
 */
function readFormBodyField(request: Request): string | null {
  // Per the RR7 contract, `request.formData()` can only be consumed once.
  // Calling it inside validateCsrf would force every route to either
  // (a) call validateCsrf AFTER formData() and pass the token explicitly
  // via `validateCsrfWithFormToken`, OR (b) accept the body-consumption
  // race. We expose option (a) as a separate helper
  // (validateCsrfWithFormToken below); the header-based path that
  // JSON/fetch mutations use is unaffected.
  //
  // This function is intentionally a no-op for the validateCsrf(request)
  // path. Routes that POST form data MUST call
  // `await readFormCsrfTokenFromBody(request)` themselves (or use the
  // `validateCsrfWithFormToken` wrapper) BEFORE any other body read.
  // The original sync-blocking concern (no Node `parseBody` in v22
  // request body) is irrelevant because `clone().formData()` is async.
  return null;
}

/**
 * Read the CSRF token out of a parsed FormData payload. Used by
 * form-POST routes that have already consumed `request.formData()`.
 * Returns null if the form has no `csrf` field.
 */
export function readFormCsrfToken(formData: FormData): string | null {
  const value = formData.get(CSRF_FORM_FIELD);
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

/**
 * Form-aware variant of `validateCsrf`. Use this in actions that
 * submit `<form>` data (no JSON, no `x-csrf-token` header from JS).
 *
 * Usage:
 * ```ts
 * export async function action({ request }: Route.ActionArgs) {
 *   const fd = await request.formData();
 *   const csrf = validateCsrfWithFormToken(request, fd);
 *   if (!csrf.ok) return csrf.response;
 *   // ... use fd ...
 * }
 * ```
 *
 * Pairs with the loader reading the cookie via `readCsrfCookie(request)`
 * and rendering `<input type="hidden" name="csrf" value={token} />`
 * inside the `<Form>`. See `_app.duties.new.tsx` for the canonical
 * render.
 */
export function validateCsrfWithFormToken(
  request: Request,
  formData: FormData,
  options: CsrfOptions = {},
):
  | { ok: true }
  | { ok: false; response: Response } {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  // Layer 1: origin/referer (same as validateCsrf).
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host') ?? '';
  const requireOrigin = options.requireOrigin ?? DEFAULT_REQUIRE_ORIGIN;

  // Audit 2026-07-22 P2-1: see validateCsrf for the rationale.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return forbidden('sec_fetch_site_cross_site');
  }

  if (!origin && !referer) {
    if (requireOrigin) {
      logger.debug('csrf: missing origin (web route requires it)');
      return forbidden('missing_origin');
    }
  } else if (origin) {
    if (!originMatches(origin, host, options.allowedHosts)) {
      return forbidden('origin_mismatch');
    }
  } else if (referer) {
    if (!refererMatches(referer, host, options.allowedHosts)) {
      return forbidden('referer_mismatch');
    }
  }

  // Layer 2: double-submit cookie + form-body csrf field.
  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken = readFormCsrfToken(formData);
  if (!cookieToken || !headerToken) return forbidden('missing_token');

  const a = Buffer.from(cookieToken);
  let b: Buffer;
  if (headerToken.length === a.length) {
    b = Buffer.from(headerToken);
  } else {
    b = Buffer.alloc(a.length);
    Buffer.from(headerToken).copy(b, 0, 0, Math.min(a.length, headerToken.length));
  }
  if (!timingSafeEqual(a, b)) return forbidden('token_mismatch');

  return { ok: true };
}



/**
 * JSON-body variant of `validateCsrf`. Use this in API action routes
 * whose callers post a JSON-encoded body (e.g. fetcher.submit with
 * encType: 'application/json'). The csrf token is read from the body
 * field `csrf` and compared to the cookie, mirroring
 * `validateCsrfWithFormToken`'s behavior but for JSON.
 *
 * Layer 1 (Origin/Referer) is preserved. Layer 2 (double-submit
 * cookie) is enforced via the JSON body, not the header.
 *
 * Usage:
 * ```ts
 * export async function action({ request }: Route.ActionArgs) {
 *   if (request.method !== 'POST') return Response.json({error:'method_not_allowed'},{status:405});
 *   const body = await request.json().catch(() => null);
 *   if (!body || typeof body !== 'object') return Response.json({error:'invalid_json'},{status:400});
 *   const csrf = validateCsrfFromJson(request, body);
 *   if (!csrf.ok) return csrf.response;
 *   // ... use body fields ...
 * }
 * ```
 */
export function validateCsrfFromJson(
  request: Request,
  body: Record<string, unknown>,
  options: CsrfOptions = {},
):
  | { ok: true }
  | { ok: false; response: Response } {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  // Layer 1: origin / referer.
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host') ?? '';
  const requireOrigin = options.requireOrigin ?? DEFAULT_REQUIRE_ORIGIN;

  // Audit 2026-07-22 P2-1: see validateCsrf for the rationale.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return forbidden('sec_fetch_site_cross_site');
  }

  if (!origin && !referer) {
    if (requireOrigin) {
      logger.debug('csrf: missing origin (web route requires it)');
      return forbidden('missing_origin');
    }
  } else if (origin) {
    if (!originMatches(origin, host, options.allowedHosts)) return forbidden('origin_mismatch');
  } else if (referer) {
    if (!refererMatches(referer, host, options.allowedHosts)) return forbidden('referer_mismatch');
  }

  // Layer 2: double-submit cookie + JSON-body csrf field.
  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken =
    typeof body[CSRF_FORM_FIELD] === 'string' ? (body[CSRF_FORM_FIELD] as string) : null;
  if (!cookieToken || !headerToken) return forbidden('missing_token');

  const a = Buffer.from(cookieToken);
  let b: Buffer;
  if (headerToken.length === a.length) {
    b = Buffer.from(headerToken);
  } else {
    b = Buffer.alloc(a.length);
    Buffer.from(headerToken).copy(b, 0, 0, Math.min(a.length, headerToken.length));
  }
  if (!timingSafeEqual(a, b)) return forbidden('token_mismatch');
  return { ok: true };
}


function originMatches(
  origin: string,
  host: string,
  allowed: ReadonlyArray<string> | undefined,
): boolean {
  // RFC 6454 §7: native-app fetch() (React Native iOS/Android) sends
  // literal Origin: null. Mobile auth relies on Layer-2 double-submit
  // cookie (trusted for native-app + cookie). CSRF rotation unchanged.
  if (origin === 'null') return true;
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
  if (candidateHost === requestHost) return true;

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      if (new URL(appUrl).host === candidateHost) return true;
    } catch {
      // ignore malformed APP_URL
    }
  }

  if (allowed?.includes(candidateHost)) return true;

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