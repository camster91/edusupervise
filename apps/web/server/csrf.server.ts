// apps/web/server/csrf.server.ts — CSRF validation via double-submit cookie.
//
// Strategy: double-submit cookie pattern. The server issues a CSRF token as
// a cookie (`__Host-edusupervise.csrf`) on the first GET request. The
// client-side fetch wrapper reads the cookie and sends the same value as
// the `x-csrf-token` header. On every state-changing request (POST, PUT,
// PATCH, DELETE) the server compares the cookie value to the header value
// using `crypto.timingSafeEqual` — equal length buffers, no early-exit
// timing leak.
//
// Why NOT better-auth's built-in CSRF:
//   - Better-auth's CSRF token is tied to its session cookie lifecycle.
//     Our cookie is rotated independently on login (spec section 5) so a
//     compromised CSRF cookie cannot outlive the session it's paired with
//     even if the session stays alive.
//   - The cookie is `HttpOnly: false` so the client-side fetch wrapper
//     can read it via `document.cookie` (this is the WHOLE POINT of the
//     double-submit pattern — the attacker cannot read the cookie from
//     a different origin).
//
// Why NO age-based rejection:
//   - Per spec section 5, the token's validity derives from the SESSION
//     lifetime, not from a server-side timestamp. The double-submit
//     pattern is stateless by design: the server just compares cookie
//     value === header value. If a session expires, the user gets a new
//     CSRF cookie on the next GET. An attacker cannot mint a CSRF token
//     because they cannot read the cookie from a different origin.

import { timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';

export const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_FORM_FIELD = '_csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF cookie size: 32 bytes → 43-char base64url (no padding). Plenty of
// entropy (256 bits) that the timing-safe compare is safe to operate on.
const CSRF_TOKEN_BYTES = 32;

/**
 * Generate a new CSRF token. Wraps `crypto.randomBytes` so the call site
 * has a stable import path that we can mock in tests.
 */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
}

// ---------------------------------------------------------------------------
// Cookie attributes — `__Host-` prefix requires Secure + Path=/ + no Domain
// ---------------------------------------------------------------------------

const isProd = process.env.NODE_ENV === 'production';

export interface CsrfCookieAttributes {
  name: string;
  httpOnly: false;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * Cookie attributes for the CSRF token. The 30-day max-age matches the
 * session expiry so a long-lived session gets a sticky CSRF token. The
 * `__Host-` prefix means this cookie will be rejected by the browser
 * unless `Secure` is set and `Path=/` and there is no `Domain=` — those
 * three rules prevent subdomain takeover attacks.
 */
export function csrfCookieAttributes(): CsrfCookieAttributes {
  return {
    name: CSRF_COOKIE_NAME,
    httpOnly: false, // MUST be JS-readable for double-submit
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}

// ---------------------------------------------------------------------------
// Validation — read cookie + header, compare timing-safely
// ---------------------------------------------------------------------------

export interface CsrfValidationOk {
  ok: true;
  /** The token from the cookie, after we've confirmed it matches the header. */
  token: string;
}

export interface CsrfValidationFail {
  ok: false;
  response: Response;
}

/**
 * Validate the CSRF token on a state-changing request. Safe methods
 * (GET, HEAD, OPTIONS) always pass.
 *
 * Returns `{ ok: true, token }` on success — callers that mint the cookie
 * use the same token. Returns `{ ok: false, response }` on failure so the
 * caller can `return response` directly without re-throwing.
 *
 * The compare is timing-safe. Tokens are base64url strings of fixed
 * length (43 chars for 32 random bytes), but we still wrap with
 * `timingSafeEqual` so a future change to variable-length tokens
 * doesn't silently downgrade the security.
 */
export function validateCsrf(request: Request):
  | CsrfValidationOk
  | CsrfValidationFail {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return { ok: true, token: '' };
  }

  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  const headerToken = readHeaderOrBody(request, CSRF_HEADER_NAME, CSRF_FORM_FIELD);

  if (!cookieToken || !headerToken) {
    return fail('csrf_missing');
  }

  // Same-string check first as a fast path — `timingSafeEqual` throws if
  // the buffers differ in length, so length-equal strings skip the throw.
  // We still wrap the slow path in `timingSafeEqual` for the constant-time
  // byte-by-byte compare.
  if (cookieToken.length !== headerToken.length) {
    return fail('csrf_mismatch');
  }
  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail('csrf_mismatch');
  }
  return { ok: true, token: cookieToken };
}

/**
 * Convenience helper: extract the CSRF cookie value without validation.
 * Used by GET handlers that want to set the cookie if it's missing.
 */
export function readCsrfCookie(request: Request): string | null {
  return readCookie(request, CSRF_COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    if (key !== name) continue;
    return pair.slice(eqIdx + 1).trim();
  }
  return null;
}

function readHeaderOrBody(
  request: Request,
  headerName: string,
  formField: string,
): string | null {
  // 1. Header — preferred for fetch() / XHR.
  const fromHeader = request.headers.get(headerName);
  if (fromHeader) return fromHeader;

  // 2. Form body — RR7 form actions send `_csrf` in the POST body.
  // We only attempt to read it when the content type looks like a form.
  const ct = request.headers.get('content-type') ?? '';
  if (
    ct.includes('application/x-www-form-urlencoded') ||
    ct.includes('multipart/form-data')
  ) {
    // We can't `await request.formData()` here because Request bodies
    // are single-use and callers downstream may need the parsed body
    // too. Instead, parse the raw body synchronously off the cache.
    //
    // RR7 routes that use FormData receive it via `await
    // request.formData()` in the action handler. The CSRF middleware
    // runs BEFORE the action in this design — but the body is buffered
    // and the action can re-parse. Calling `request.clone().formData()`
    // here would race with the action's `request.formData()`.
    //
    // The accepted pattern for form-based CSRF is: the action handler
    // also validates (using the same `validateCsrf` after parsing the
    // body). The middleware pre-check only catches XHR/fetch.
    //
    // For now, this helper returns the header-only value. Form-action
    // handlers call validateCsrf after they've already parsed the body,
    // and pass the form-field value via a small wrapper (see
    // `validateCsrfFromForm` below).
    return null;
  }
  return null;
}

function fail(reason: 'csrf_missing' | 'csrf_mismatch'): CsrfValidationFail {
  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'csrf_failed', detail: reason }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  };
}

// ---------------------------------------------------------------------------
// Form-aware helper — use AFTER parsing request.formData()
// ---------------------------------------------------------------------------

/**
 * Validate CSRF for a form submission where the body has already been
 * parsed. Reads `cookieToken` from the request and compares against
 * `formToken` extracted from a parsed FormData entry.
 *
 * The double-submit pattern still applies: the cookie is set by the
 * server on first GET, the form embeds the same token in a hidden input,
 * and the server compares them at submit time.
 */
export function validateCsrfFromForm(
  request: Request,
  formToken: string | null,
):
  | CsrfValidationOk
  | CsrfValidationFail {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return { ok: true, token: '' };
  }
  const cookieToken = readCookie(request, CSRF_COOKIE_NAME);
  if (!cookieToken || !formToken) return fail('csrf_missing');
  if (cookieToken.length !== formToken.length) return fail('csrf_mismatch');
  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(formToken, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail('csrf_mismatch');
  }
  return { ok: true, token: cookieToken };
}

/**
 * Build the Set-Cookie header value for a freshly minted CSRF token.
 * Route loaders call this on first GET to make sure the cookie exists.
 */
export function buildCsrfSetCookie(token: string): string {
  const attrs = csrfCookieAttributes();
  const parts = [
    `${attrs.name}=${token}`,
    `Path=${attrs.path}`,
    `Max-Age=${attrs.maxAge}`,
    `SameSite=${capitalize(attrs.sameSite)}`,
  ];
  if (attrs.secure) parts.push('Secure');
  // HttpOnly is intentionally absent — the cookie must be JS-readable.
  return parts.join('; ');
}

/**
 * Same as `buildCsrfSetCookie` but always `Secure`, regardless of env.
 * Use for the post-login rotation step so the new cookie is HTTPS-pinned
 * even if the previous one was on a non-prod host.
 */
export function buildCsrfSetCookieSecure(token: string): string {
  const attrs = csrfCookieAttributes();
  const parts = [
    `${attrs.name}=${token}`,
    `Path=${attrs.path}`,
    `Max-Age=${attrs.maxAge}`,
    'SameSite=Lax',
    'Secure',
  ];
  void attrs; // keep lint happy if attrs is later customized
  return parts.join('; ');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}