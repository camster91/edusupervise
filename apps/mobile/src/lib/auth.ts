// src/lib/auth.ts
//
// Mobile auth: signIn / signUpDemo / signOut / getSession / getCsrfToken.
// Reuses the web's HMAC session cookie (no new auth system) by:
//
//   1. GET /login (or any GET route) — mints the CSRF cookie on the
//      server. We parse Set-Cookie and persist `__Host-edusupervise.csrf`
//      in expo-secure-store.
//   2. POST /login with form-encoded body containing csrf + email +
//      password. The server validates CSRF, signs the user in, rotates
//      the CSRF token, and sets `edusupervise.session` + the rotated
//      `__Host-edusupervise.csrf` cookies. We parse the Set-Cookie
//      response and persist both into expo-secure-store.
//
// The signUpDemo path is identical except the POST target is
// /api/signup/demo and the body includes name + email + password.
//
// signOut: POST /api/mobile/push/unsubscribe (E-005: revoke Expo token
// FIRST so the next user on this device doesn't inherit it), then
// POST /logout, then clear our two secure-store keys.

import * as SecureStore from 'expo-secure-store';
import { api, ApiError, getApiBaseUrl } from './api';
import {
  parseAllSetCookies,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from './cookies';

/**
 * The Expo-secure-store `keychainAccessible` flag we use on iOS to
 * prevent the cookie from syncing through iCloud Keychain to other
 * devices (incl. family-shared iPads). On Android, expo-secure-store
 * ignores the flag (the Android Keystore is device-only by default).
 *
 * Why this matters: a teacher's session cookie (HMAC-signed, 30-day
 * TTL) on a school-issued iPad would otherwise sync to her personal
 * iPhone, her home Mac, and any family-shared iPads she manages —
 * a session-hijack vector on shared devices, especially in K-12.
 *
 * See slice E report 2026-07-06, finding E-009.
 */
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Clear both cookies from secure-store. Used on sign-out and on any
 *  explicit "forget this session" path (e.g. 401 on a previously-valid
 *  request). */
export async function clearStoredAuth(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_COOKIE_NAME).catch(() => null),
    SecureStore.deleteItemAsync(CSRF_COOKIE_NAME).catch(() => null),
  ]);
}

/** Persist a cookie name→value map into secure-store. Only persists
 *  the names we know about (session + csrf) — silently ignores others.
 *  Both writes pass the device-only keychain-accessible flag (E-009)
 *  so the cookies do not sync to iCloud Keychain. */
async function persistCookies(map: Record<string, string>): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (typeof map[SESSION_COOKIE_NAME] === 'string') {
    tasks.push(
      SecureStore.setItemAsync(
        SESSION_COOKIE_NAME,
        map[SESSION_COOKIE_NAME]!,
        SECURE_STORE_OPTIONS,
      ).then(() => undefined),
    );
  }
  if (typeof map[CSRF_COOKIE_NAME] === 'string') {
    tasks.push(
      SecureStore.setItemAsync(
        CSRF_COOKIE_NAME,
        map[CSRF_COOKIE_NAME]!,
        SECURE_STORE_OPTIONS,
      ).then(() => undefined),
    );
  }
  await Promise.all(tasks);
}

export interface SignInResult {
  ok: true;
}
export interface SignInError {
  ok: false;
  status: number;
  code: string;
  message: string;
}

/** Read the CSRF cookie from the server by hitting a safe (GET) route
 *  that mints one. We use /login because the loader explicitly mints
 *  the cookie via ensureCsrfCookie. The Set-Cookie is parsed and
 *  persisted before we return. */
async function fetchAndStoreCsrf(): Promise<void> {
  const url = `${getApiBaseUrl()}/login`;
  // We do NOT use apiFetch() for the GET-mint — that helper attaches
  // our existing CSRF cookie from secure-store, but on a fresh install
  // there is none. The server's loader doesn't care: it always returns
  // a valid token (either the existing one or a freshly minted one).
  const response = await fetch(url, { method: 'GET', credentials: 'omit' });
  // We don't care about the response body; we only want the Set-Cookie
  // headers. A 200 is the success path; 5xx would mean the server is
  // broken and we can't proceed.
  if (!response.ok && response.status >= 500) {
    throw new ApiError(response.status, {
      error: 'server_unavailable',
      detail: `GET /login returned ${response.status}`,
    });
  }
  const cookies = parseAllSetCookies(response.headers);
  await persistCookies(cookies);
}

export interface SignInInput {
  email: string;
  password: string;
}

export type SignInOutcome = SignInResult | SignInError;

/**
 * Sign in with email + password. Reuses the web's HMAC session cookie
 * exactly — no new auth system.
 *
 * Flow:
 *   1. GET /login to mint the CSRF cookie (if we don't have one).
 *   2. POST /login with form-encoded body (csrf + email + password),
 *      using the freshly-stored CSRF cookie. The server validates
 *      CSRF, signs the user in, and sets `edusupervise.session` +
 *      the rotated CSRF cookie.
 *   3. Parse Set-Cookie from the POST response, persist both cookies
 *      into secure-store. Now subsequent requests via apiFetch() will
 *      send Cookie + x-csrf-token automatically.
 */
export async function signIn(input: SignInInput): Promise<SignInOutcome> {
  await fetchAndStoreCsrf();

  const csrf = await SecureStore.getItemAsync(CSRF_COOKIE_NAME);
  if (!csrf) {
    return {
      ok: false,
      status: 0,
      code: 'csrf_missing',
      message: 'Could not get a CSRF token. Check your network and try again.',
    };
  }

  const url = `${getApiBaseUrl()}/login`;
  const body = new URLSearchParams({
    csrf,
    email: input.email.trim().toLowerCase(),
    password: input.password,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      },
      body: body.toString(),
      // Follow the 302 manually so we can read Set-Cookie from the
      // 302 response itself (not the final /app page).
      redirect: 'manual',
      credentials: 'omit',
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: 'network_error',
      message: e instanceof Error ? e.message : 'Network error',
    };
  }

  const cookies = parseAllSetCookies(response.headers);
  await persistCookies(cookies);

  if (response.status === 302 || response.status === 200) {
    if (cookies[SESSION_COOKIE_NAME]) {
      return { ok: true };
    }
    return {
      ok: false,
      status: response.status,
      code: 'no_session_cookie',
      message: 'Server did not return a session cookie. Try again.',
    };
  }

  // 4xx — read the body for an error code.
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    // ignore
  }
  let code = 'signin_failed';
  if (response.status === 401) code = 'invalid_credentials';
  else if (response.status === 429) code = 'rate_limited';
  else if (response.status === 403) code = 'csrf_failed';
  else if (response.status >= 500) code = 'server_error';

  return {
    ok: false,
    status: response.status,
    code,
    message:
      response.status === 401
        ? 'Invalid email or password.'
        : response.status === 429
          ? 'Too many sign-in attempts. Try again in a few minutes.'
          : bodyText || `Sign-in failed (HTTP ${response.status}).`,
  };
}

export interface SignUpDemoInput {
  name: string;
  email: string;
  password: string;
}

export type SignUpDemoOutcome = SignInResult | SignInError;

/**
 * Create a pre-seeded 30-day demo school + sign in. Same CSRF + cookie
 * flow as signIn, but POSTs to /api/signup/demo with name+email+password
 * in the form body. On success the server redirects to /app/today and
 * sets the session cookie. Demo accounts are the easiest test path
 * during slice A.
 */
export async function signUpDemo(input: SignUpDemoInput): Promise<SignUpDemoOutcome> {
  await fetchAndStoreCsrf();

  const csrf = await SecureStore.getItemAsync(CSRF_COOKIE_NAME);
  if (!csrf) {
    return {
      ok: false,
      status: 0,
      code: 'csrf_missing',
      message: 'Could not get a CSRF token. Check your network and try again.',
    };
  }

  const url = `${getApiBaseUrl()}/api/signup/demo`;
  const body = new URLSearchParams({
    csrf,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    password: input.password,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      },
      body: body.toString(),
      redirect: 'manual',
      credentials: 'omit',
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: 'network_error',
      message: e instanceof Error ? e.message : 'Network error',
    };
  }

  const cookies = parseAllSetCookies(response.headers);
  await persistCookies(cookies);

  if (response.status === 302 || response.status === 200) {
    if (cookies[SESSION_COOKIE_NAME]) {
      return { ok: true };
    }
    return {
      ok: false,
      status: response.status,
      code: 'no_session_cookie',
      message: 'Server did not return a session cookie. Try again.',
    };
  }

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    // ignore
  }
  let code = 'signup_failed';
  if (response.status === 400) code = 'invalid_input';
  else if (response.status === 429) code = 'rate_limited';
  else if (response.status === 403) code = 'csrf_failed';
  else if (response.status >= 500) code = 'server_error';

  return {
    ok: false,
    status: response.status,
    code,
    message: bodyText || `Sign-up failed (HTTP ${response.status}).`,
  };
}

export interface SignOutResult {
  ok: true;
}
export type SignOutOutcome = SignOutResult | SignInError;

/**
 * Sign out: revoke the Expo push token server-side (E-005: otherwise
 * the next user on this device inherits the previous user's push
 * subscription and gets pings meant for the previous user), then
 * invalidate the web session, then clear both cookies from secure-store.
 *
 * Push unsubscribe is called FIRST so even if /logout fails the device
 * stops receiving pushes for this user. A 404 (slice C endpoint not
 * yet shipped) is treated as success — the server has no token to
 * revoke in that case.
 */
export async function signOut(): Promise<SignOutOutcome> {
  const csrf = await SecureStore.getItemAsync(CSRF_COOKIE_NAME);

  // 1. Revoke the Expo push subscription server-side (E-005).
  if (csrf) {
    try {
      const unsubscribeUrl = `${getApiBaseUrl()}/api/mobile/push/unsubscribe`;
      const cookieHeader = `${CSRF_COOKIE_NAME}=${csrf}`;
      const response = await fetch(unsubscribeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-csrf-token': csrf,
          Cookie: cookieHeader,
        },
        credentials: 'omit',
      });
      // Drain the body; do not act on it. 404 (slice C endpoint not
      // yet shipped) is non-fatal. So is 401 (session already
      // expired). We log nothing — this is a best-effort path.
      try {
        await response.text();
      } catch {
        // ignore
      }
    } catch {
      // Network failure on push-unsubscribe is non-fatal.
    }
  }

  // 2. Invalidate the web session.
  if (csrf) {
    const url = `${getApiBaseUrl()}/logout`;
    const body = new URLSearchParams({ csrf });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
        },
        body: body.toString(),
        redirect: 'manual',
        credentials: 'omit',
      });
      // Drain the body to free the connection; we don't act on it.
      try {
        await response.text();
      } catch {
        // ignore
      }
    } catch {
      // Network failure on logout is non-fatal — we still clear local state.
    }
  }

  // 3. Always clear local state, even if the server calls failed.
  await clearStoredAuth();
  return { ok: true };
}

/** Read the session cookie from secure-store. Returns null if absent. */
export async function getSession(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_COOKIE_NAME).catch(() => null);
}

/** Read the CSRF cookie from secure-store. Returns null if absent. */
export async function getCsrfToken(): Promise<string | null> {
  return SecureStore.getItemAsync(CSRF_COOKIE_NAME).catch(() => null);
}

/**
 * Verify the stored session is still valid by hitting GET /app/today.
 * Returns true if the server returns 2xx, false if 401 (session
 * expired/invalid) or any other failure. Used by the splash screen
 * to decide whether to route to sign-in or to today.
 */
export async function verifySession(): Promise<boolean> {
  // We hit /app/api/today (the JSON shim) so the response shape is
  // stable and small — same path the post-sign-in Today screen will
  // use. If the response is 401, the session is dead and we clear
  // local state. Any other failure (network, 5xx) is treated as
  // "let the user through" — the Today screen will surface the
  // real error.
  const res = await api.get(`${getApiBaseUrl()}/app/api/today`);
  if (res.ok) return true;
  if (res.status === 401) {
    await clearStoredAuth();
    return false;
  }
  // Network error (status 0) or 5xx — be lenient.
  return true;
}
