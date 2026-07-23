// src/lib/cookies.ts
//
// Parse Set-Cookie response headers into a {name, value} map ready for
// expo-secure-store. The web server's login + CSRF flows set two cookies:
//
//   Set-Cookie: edusupervise.session=<token>; Path=/; HttpOnly; SameSite=Lax
//   Set-Cookie: __Host-edusupervise.csrf=<token>; Path=/; Secure
//
// They arrive as either:
//   - a single header value with multiple comma-separated cookie specs
//     (the WHATWG Fetch Headers.get() path)
//   - a list of values accessible via headers.getSetCookie() (Fetch spec
//     way to enumerate Set-Cookie without losing multi-cookie ordering)
//
// We support both because React Native's fetch polyfill has historically
// only exposed the first form, while modern (RN 0.76+) exposes
// getSetCookie(). See: https://github.com/facebook/react-native/issues/23922
//
// ATTRIBUTION: React Native + fetch known-quirk — Set-Cookie is
// intentionally hidden from response.headers in browsers; the RN polyfill
// has alternated between supporting it, returning null, and only returning
// the first value. If neither path works, the fallback is a server-side
// mirror endpoint that returns the cookies in the response body — NOT
// added in slice A (would touch the web auth code, which is forbidden).

/**
 * A single parsed cookie — just name + value. The web server's cookies we
 * care about have no expiry we need to honor (we mirror the server's
 * Path=/ + Max-Age behavior implicitly by re-reading on every request).
 */
export interface ParsedCookie {
  name: string;
  value: string;
}

/**
 * The two cookies we persist. Names must match the web auth + CSRF
 * server modules byte-for-byte — see:
 *   apps/web/server/auth.server.ts:29  (SESSION_COOKIE = 'edusupervise.session')
 *   apps/web/server/csrf.server.ts:63  (CSRF_COOKIE_NAME = '__Host-edusupervise.csrf')
 */
export const SESSION_COOKIE_NAME = 'edusupervise.session';
export const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';

/**
 * Try to read all Set-Cookie header values from a Fetch Headers instance.
 *
 * Order of preference:
 *   1. headers.getSetCookie() — Fetch spec method, returns every
 *      Set-Cookie as a separate string. Available on RN 0.76+ (Expo SDK 52).
 *   2. headers.get('set-cookie') — single string, comma-separated
 *      cookie specs. Older RN polyfill path.
 *   3. headers.raw?.() — non-standard but exposes the underlying map.
 *   4. Empty array.
 *
 * Returns a flat array of raw Set-Cookie strings.
 */
export function readSetCookieHeaders(headers: Headers): string[] {
  // 1. Modern: getSetCookie() is a Fetch-spec method.
  const spec = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof spec === 'function') {
    try {
      const arr = spec.call(headers);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {
      // fall through
    }
  }

  // 2. WHATWG single-string path.
  const single = headers.get('set-cookie');
  if (single) return [single];

  // 3. Some RN versions expose .raw() — defensive.
  const raw = (headers as unknown as { raw?: () => Record<string, string[]> }).raw;
  if (typeof raw === 'function') {
    try {
      const map = raw.call(headers);
      const values = map['set-cookie'] ?? map['Set-Cookie'];
      if (Array.isArray(values) && values.length > 0) return values;
    } catch {
      // fall through
    }
  }

  return [];
}

/**
 * Parse a single Set-Cookie string into a {name, value} pair. Ignores
 * attributes (Path, HttpOnly, Secure, SameSite, Max-Age, Domain). The
 * server already enforces the security attributes; we just need the
 * name=value to put into the secure store.
 *
 * Example: "edusupervise.session=abc.def; Path=/; HttpOnly; SameSite=Lax"
 *       -> { name: "edusupervise.session", value: "abc.def" }
 *
 * Note: cookie values CAN legally contain commas (per RFC 6265 §4.1.1
 * when quoted). We don't try to be fully spec-compliant — the web's
 * session and CSRF cookies never include commas in their values (the
 * session is base64url with no padding, the CSRF is base64url 32 bytes).
 */
export function parseSetCookie(setCookie: string): ParsedCookie | null {
  const trimmed = setCookie.trim();
  if (!trimmed) return null;

  // Strip optional leading whitespace + cookie name.
  const semi = trimmed.indexOf(';');
  const firstSegment = semi === -1 ? trimmed : trimmed.slice(0, semi);
  const eq = firstSegment.indexOf('=');
  if (eq === -1) return null;

  const name = firstSegment.slice(0, eq).trim();
  let value = firstSegment.slice(eq + 1).trim();
  if (!name) return null;

  // Strip optional surrounding double quotes (some servers quote values).
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }

  return { name, value };
}

/**
 * Parse ALL Set-Cookie headers from a Fetch Headers object into a
 * name→value map. Multiple Set-Cookie values for the same name are
 * resolved by "last write wins" (matches browser semantics).
 */
export function parseAllSetCookies(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readSetCookieHeaders(headers)) {
    const parsed = parseSetCookie(raw);
    if (parsed) out[parsed.name] = parsed.value;
  }
  return out;
}

/**
 * Build a `Cookie:` request header value from a map of cookie name →
 * value. Returns empty string when the map is empty (the caller can
 * still set the header — empty `Cookie:` is harmless and avoids a
 * "Cookie header present but empty" warning some servers emit).
 *
 * Values are emitted in insertion order. We don't bother sorting
 * because the server only cares about named cookies, and a fresh
 * session has at most two entries.
 */
export function buildCookieHeader(cookies: Record<string, string | null | undefined>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(cookies)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}
