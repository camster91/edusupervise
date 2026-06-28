// app/lib/csrf.ts — client-side CSRF helpers.
//
// Used by the `fetch` wrapper in `app/lib/api.ts` to attach the CSRF
// token to every mutation. Also used by forms that submit via RR7 form
// actions: those pass the token as a hidden form field rather than a
// header, so we expose `csrfFormField()` for that case.
//
// How the token gets into the browser:
//   1. User hits any GET route → server's `attachCsrfCookie()` sets the
//      `__Host-edusupervise.csrf` cookie (HttpOnly=false).
//   2. This module reads `document.cookie` and extracts the value.
//   3. On every fetch mutation, the value is sent as `x-csrf-token`.
//
// We do NOT cache the token in module state because the cookie can rotate
// (login success, server restart, etc.). Reading on every request is
// cheap (single string scan) and immune to staleness.

/** Cookie name. Must match `csrf.server.ts#CSRF_COOKIE_NAME`. */
export const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';

/** Header name for JSON/fetch mutations. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Form field name for RR7 form action submissions. */
export const CSRF_FORM_FIELD = 'csrf';

/**
 * Read the CSRF token from `document.cookie`. Returns null when:
 *   - the cookie has not been set yet (no GET has run on this origin)
 *   - the document.cookie API is unavailable (server-side / SSR)
 *   - the cookie's HttpOnly flag is true (it should NOT be — see
 *     csrf.server.ts#serializeCsrfCookie for the dev/prod split)
 */
export function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const pair of cookies) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (name !== CSRF_COOKIE_NAME) continue;
    return decodeURIComponent(pair.slice(eqIdx + 1).trim());
  }
  return null;
}

/**
 * Build the `x-csrf-token` header pair, omitting the header entirely
 * when no token is available. Callers should pass-through null headers
 * rather than fabricate one — an empty header fails server validation
 * just like a missing one, and a fabricated one fails by token mismatch
 * after the second check.
 */
export function csrfHeader(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { [CSRF_HEADER_NAME]: token } : {};
}

/**
 * Render a hidden `<input>` for inclusion in `<Form method="post">`
 * JSX. The Form action's body parser extracts the value via the
 * `CSRF_FORM_FIELD` name (mirrors `csrf.server.ts#CSRF_FORM_FIELD`).
 */
export function csrfFormField(): { name: string; value: string } {
  const token = readCsrfToken();
  return { name: CSRF_FORM_FIELD, value: token ?? '' };
}