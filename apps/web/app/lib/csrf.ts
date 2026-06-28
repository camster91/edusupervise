// apps/web/app/lib/csrf.ts — client-side CSRF token helpers.
//
// The double-submit cookie pattern requires the client to:
//   1. Read the `__Host-edusupervise.csrf` cookie (set by the server on
//      the first GET response).
//   2. Attach the same value as the `x-csrf-token` header on every
//      state-changing fetch.
//
// This file exports:
//   - `getCsrfToken()` — synchronous read of the cookie value.
//   - `csrfFetch(input, init)` — drop-in `fetch` replacement that
//     attaches the header automatically on non-safe methods.
//   - `setCsrfTokenInForm(form)` — for RR7 form actions, writes the
//     cookie value into a hidden `_csrf` input.
//
// Edge cases:
//   - The cookie is `HttpOnly: false` (this is the whole point of the
//     double-submit pattern). `document.cookie` reads it.
//   - On the `__Host-` prefix: cookies with `__Host-` cannot be read
//     from JavaScript on a different origin (which is exactly the
//     attack we are defending against). On the same origin, the prefix
//     is transparent — `document.cookie` returns the name without it.
//   - If the cookie is missing (e.g. the user landed on a non-GET page
//     or the server forgot to set it), `csrfFetch` makes a one-shot
//     GET to /api/csrf-init? Actually no — we want the server to set
//     the cookie on the next navigation. We just send the request
//     without the token, the server returns 403, and the UI redirects
//     to a page that primes the cookie.

const CSRF_COOKIE_NAME = '__Host-edusupervise.csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_FORM_FIELD = '_csrf';

/**
 * Synchronous read of the CSRF cookie. Returns null if the cookie is
 * missing (typically on first navigation before any GET has set it).
 */
export function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const pair of document.cookie.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (name !== CSRF_COOKIE_NAME) continue;
    const value = pair.slice(eqIdx + 1).trim();
    return value || null;
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `fetch` wrapper that attaches `x-csrf-token` on state-changing requests.
 *
 * Safe methods (GET, HEAD, OPTIONS) pass through untouched.
 *
 * If the CSRF cookie is missing, this throws — caller should redirect to
 * a page that primes the cookie (e.g. the index page) and retry. We
 * intentionally do NOT auto-GET a priming endpoint because that adds a
 * network round-trip to every mutation when the cookie is unset.
 */
export async function csrfFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const token = getCsrfToken();
    if (!token) {
      throw new Error(
        'csrfFetch: CSRF cookie is missing. Refresh the page to prime it.',
      );
    }
    const headers = new Headers(init.headers ?? undefined);
    headers.set(CSRF_HEADER_NAME, token);
    init = { ...init, headers };
  }
  return fetch(input, init);
}

/**
 * Inject the CSRF token into a `<form>` element as a hidden `_csrf`
 * input. Idempotent — replaces an existing hidden `_csrf` input if
 * present.
 */
export function setCsrfTokenInForm(form: HTMLFormElement): void {
  const token = getCsrfToken();
  if (!token) return;
  let input = form.querySelector<HTMLInputElement>(
    `input[name="${CSRF_FORM_FIELD}"]`,
  );
  if (!input) {
    input = document.createElement('input');
    input.type = 'hidden';
    input.name = CSRF_FORM_FIELD;
    form.appendChild(input);
  }
  input.value = token;
}

export const CSRF_NAMES = {
  cookie: CSRF_COOKIE_NAME,
  header: CSRF_HEADER_NAME,
  formField: CSRF_FORM_FIELD,
} as const;