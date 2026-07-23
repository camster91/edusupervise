// apps/mobile/src/lib/api.ts
//
// Mobile fetch wrapper. Mirrors apps/web/app/lib/api.ts but lives in a
// non-browser environment: cookies are read from expo-secure-store (not
// document.cookie), and there is no `credentials: 'same-origin'` knob
// (the request cookie is assembled manually into the Cookie: header).
//
// CONTRACT (envelope):
//   apiFetch returns { status, data, ok } where:
//     - status: HTTP status code (0 if the request never reached the wire)
//     - data:   parsed JSON body (null on 204, or when the body is empty)
//     - ok:     status >= 200 && status < 300
//
//   apiFetch DOES NOT throw on non-2xx. Callers branch on `status` /
//   `ok`. This matches what useToday() + duty-complete.ts already
//   depend on, and avoids the awkward try/catch dance for expected
//   non-2xx responses (401, 403, 429, 5xx).
//
// Per slice A spec:
//   - On every request, reads `edusupervise.session` and
//     `__Host-edusupervise.csrf` from expo-secure-store and assembles a
//     `Cookie:` header.
//   - For mutating methods (POST/PUT/PATCH/DELETE), also reads CSRF
//     token and sets `x-csrf-token` header.
//   - Returns typed responses.
//
// Env: EXPO_PUBLIC_API_BASE_URL. Defaults to https://edusupervise.ashbi.ca.
//
// INTEGRATION NOTE (orchestrator, 2026-07-06):
//   Slice C (push notifications) imports three helpers — isAuthenticated(),
//   getCookieHeader(), getCsrfToken() — from this module. Those two
//   additional functions are added below for slice C's push registration
//   path. They use slice A's auth.ts source-of-truth (getSession, getCsrfToken)
//   so the secure-store reads happen in exactly one place.

import * as SecureStore from 'expo-secure-store';
import {
  buildCookieHeader,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from './cookies';
import { getSession, getCsrfToken as getCsrfTokenInternal } from './auth';

const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://edusupervise.ashbi.ca';

/** The envelope apiFetch returns. `data` is `T | null` because 204
 *  responses have no body, and we want the caller's type to be honest
 *  about the null case. */
export interface ApiEnvelope<T> {
  status: number;
  data: T | null;
  ok: boolean;
}

/** The standard error body the web returns from every mutating route.
 *  Re-exported from apps/mobile/src/types/api.ts#ApiErrorBody so the
 *  contract lives in one place. Audit 2026-07-22 P2-12. */
import type { ApiErrorBody } from '../types/api';
export type { ApiErrorBody };

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiRequestInit extends Omit<RequestInit, 'body' | 'headers'> {
  body?: BodyInit | object | null;
  headers?: HeadersInit;
  /** Skip CSRF header for endpoints that intentionally bypass (e.g. login
   *  itself, which posts the csrf form field instead). */
  skipCsrf?: boolean;
  /** Skip Cookie header for endpoints that intentionally bypass (public
   *  routes, e.g. GET /login for the initial CSRF mint). */
  skipCookie?: boolean;
}

async function readCookiesFromSecureStore(): Promise<Record<string, string>> {
  const [session, csrf] = await Promise.all([
    SecureStore.getItemAsync(SESSION_COOKIE_NAME).catch(() => null),
    SecureStore.getItemAsync(CSRF_COOKIE_NAME).catch(() => null),
  ]);
  const out: Record<string, string> = {};
  if (session) out[SESSION_COOKIE_NAME] = session;
  if (csrf) out[CSRF_COOKIE_NAME] = csrf;
  return out;
}

/**
 * Issue a fetch to one of our resource routes. Returns an envelope —
 * see the file header for the contract. NEVER throws on non-2xx.
 *
 * Skips the React-Native-fetch `credentials: 'same-origin'` knob (it
 * doesn't exist for us — we ARE the cookie layer) and instead assembles
 * the Cookie header by hand.
 *
 * `input` can be a path (relative — joined with the API base URL) or a
 * full URL. Most callers pass a path like `/app/api/today` so the
 * base URL stays in one place.
 */
export async function apiFetch<T = unknown>(
  input: string | URL,
  init: ApiRequestInit = {},
): Promise<ApiEnvelope<T>> {
  const { body, headers, skipCsrf, skipCookie, ...rest } = init;

  // Resolve relative paths against the API base URL.
  const url =
    typeof input === 'string' && !/^https?:\/\//.test(input)
      ? `${API_BASE_URL}${input.startsWith('/') ? '' : '/'}${input}`
      : input;

  const finalHeaders = new Headers(headers ?? {});

  // Auto-apply JSON content-type for non-form bodies.
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
    if (!finalHeaders.has('Content-Type')) {
      finalHeaders.set('Content-Type', 'application/json');
      finalHeaders.set('Accept', 'application/json');
    }
  }

  // Attach cookies (when not skipped) and CSRF header (when not skipped
  // AND method is mutating AND a CSRF token is present).
  if (!skipCookie) {
    const cookies = await readCookiesFromSecureStore();
    const cookieHeader = buildCookieHeader(cookies);
    if (cookieHeader) finalHeaders.set('Cookie', cookieHeader);
  }

  if (!skipCsrf && init.method && MUTATING_METHODS.has(init.method.toUpperCase())) {
    // The session + CSRF cookie are read together (slice A's
    // `readCookiesFromSecureStore` is the single source of truth for
    // secure-store access — keeps the cookie-read code in one place).
    // We only need the CSRF value here.
    const cookies = await readCookiesFromSecureStore();
    const token = cookies[CSRF_COOKIE_NAME];
    if (token) finalHeaders.set('x-csrf-token', token);
  }

  // Serialize object bodies to JSON. FormData / Blob / strings pass through.
  const finalBody =
    body === undefined || body === null
      ? undefined
      : body instanceof FormData ||
          body instanceof Blob ||
          body instanceof ArrayBuffer ||
          typeof body === 'string'
        ? body
        : JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: finalHeaders,
      body: finalBody,
    });
  } catch (e) {
    return {
      status: 0,
      data: {
        error: 'network_error',
        detail: e instanceof Error ? e.message : String(e),
      } as unknown as T | null,
      ok: false,
    };
  }

  if (response.status === 204) {
    return { status: 204, data: null, ok: true };
  }

  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: 'invalid_json', detail: text.slice(0, 500) };
    }
  } else {
    parsed = null;
  }

  return {
    status: response.status,
    data: parsed as T | null,
    ok: response.ok,
  };
}

/** Convenience HTTP-verb wrappers. They all return the same envelope. */
export const api = {
  get: <T = unknown>(url: string | URL, init?: ApiRequestInit) =>
    apiFetch<T>(url, { ...init, method: 'GET' }),
  post: <T = unknown>(url: string | URL, body?: unknown, init?: ApiRequestInit) =>
    apiFetch<T>(url, { ...init, method: 'POST', body: body as object }),
  put: <T = unknown>(url: string | URL, body?: unknown, init?: ApiRequestInit) =>
    apiFetch<T>(url, { ...init, method: 'PUT', body: body as object }),
  patch: <T = unknown>(url: string | URL, body?: unknown, init?: ApiRequestInit) =>
    apiFetch<T>(url, { ...init, method: 'PATCH', body: body as object }),
  delete: <T = unknown>(url: string | URL, init?: ApiRequestInit) =>
    apiFetch<T>(url, { ...init, method: 'DELETE' }),
};

/** Export the API base URL so screens can build absolute URLs. */
export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

// ---------------------------------------------------------------------------
// Slice C helpers (push notifications + app-shell gate)
// ---------------------------------------------------------------------------

/**
 * Returns true if a session cookie is present in expo-secure-store.
 * Cheap (no network round-trip). Use this at app start / push
 * registration to decide "should we even try to talk to the server?".
 *
 * NOTE: a present cookie does NOT guarantee a valid session — the
 * cookie could be expired or revoked server-side. The server's
 * `/api/mobile/push/subscribe` response status tells the caller if
 * the session is dead (401). For push registration specifically,
 * "have cookie" is the right gate; the upsert is idempotent.
 *
 * Source of truth: slice A's auth.ts#getSession. This is a thin
 * shim so slice C doesn't have to import from auth.ts directly.
 */
export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return session !== null && session.length > 0;
}

/**
 * Returns the `Cookie:` header value assembled from the session
 * and CSRF cookie values stored in expo-secure-store. Returns an
 * empty string when neither cookie is present (the caller may still
 * send it — empty `Cookie:` is harmless on our server).
 *
 * Source of truth: slice A's auth.ts#getSession + auth.ts#getCsrfToken
 * + cookies.ts#buildCookieHeader. This is the async wrapper that
 * ties them together; the secure-store reads happen in exactly one
 * place so changes to the storage layer only need to land in one file.
 */
export async function getCookieHeader(): Promise<string> {
  const [session, csrf] = await Promise.all([
    getSession(),
    getCsrfTokenInternal(),
  ]);
  return buildCookieHeader({
    [SESSION_COOKIE_NAME]: session,
    [CSRF_COOKIE_NAME]: csrf,
  });
}

/**
 * Re-export of slice A's CSRF cookie reader. Push registration
 * (slice C) and other callers want just the token value (for the
 * JSON-body `csrf` field, security review E-008). This is a thin
 * re-export — the underlying read lives in auth.ts so the secure-
 * store access pattern is centralized.
 */
export async function getCsrfToken(): Promise<string | null> {
  return getCsrfTokenInternal();
}

// Internal — kept here for callers (auth.ts#fetchAndStoreCsrf) that
// want to throw an `ApiError` rather than branch on the envelope.
// Not part of the public API surface; treat as legacy.
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(`API error ${status}: ${body.error}`);
  }
}
