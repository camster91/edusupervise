// app/lib/api.ts — fetch wrapper with CSRF + error normalization.
//
// The single point of contact for client → server HTTP. Every mutation
// fetch goes through this module so:
//   - the CSRF token is always attached
//   - JSON responses are parsed + typed
//   - non-2xx responses are normalized to thrown `ApiError`s with a
//     consistent shape `{ error, status, ...details }`
//
// React Router form actions bypass this module (they're plain HTML
// submissions) — they handle CSRF by including the `csrf` hidden field
// from `csrfFormField()`. The fetch wrapper is for client-side JS that
// calls the resource routes directly (e.g. from `useFetcher().submit`).

import { csrfHeader } from './csrf';

export interface ApiErrorBody {
  /** Stable machine-readable error code (e.g. 'unauthorized'). */
  error: string;
  /** Free-text detail; not localized. */
  detail?: string;
  /** Optional structured fields (e.g. plan_limit_exceeded's `limit`). */
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'body' | 'headers'> {
  body?: BodyInit | object | null;
  headers?: HeadersInit;
  /** Skip CSRF for endpoints that intentionally bypass (Stripe webhook). */
  skipCsrf?: boolean;
}

const JSON_HEADERS: HeadersInit = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/**
 * Issue a fetch to one of our resource routes. Throws `ApiError` on
 * non-2xx responses; otherwise returns the parsed JSON body typed as `T`.
 *
 * The function is safe to call from any browser context — it adds the
 * CSRF header automatically when a token is available. Server-side
 * callers should use raw `fetch()` because the cookie isn't readable.
 */
export async function apiFetch<T = unknown>(
  input: string | URL,
  init: ApiRequestInit = {},
): Promise<T> {
  const { body, headers, skipCsrf, ...rest } = init;

  const finalHeaders = new Headers(headers ?? {});
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
    if (!finalHeaders.has('Content-Type')) {
      for (const [k, v] of Object.entries(JSON_HEADERS)) {
        finalHeaders.set(k, v as string);
      }
    }
  }
  if (!skipCsrf) {
    for (const [k, v] of Object.entries(csrfHeader())) {
      finalHeaders.set(k, v as string);
    }
  }

  const finalBody =
    body === undefined || body === null
      ? undefined
      : body instanceof FormData ||
          body instanceof Blob ||
          body instanceof ArrayBuffer ||
          typeof body === 'string'
        ? body
        : JSON.stringify(body);

  const response = await fetch(input, {
    ...rest,
    headers: finalHeaders,
    body: finalBody,
    credentials: 'same-origin',
  });

  // 204 No Content / empty body — caller gets null.
  if (response.status === 204) return null as T;

  // Try to parse JSON. If it isn't JSON, fall back to text so the
  // error message still has useful context.
  let parsed: unknown;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: 'invalid_json', detail: text.slice(0, 500) };
    }
  } else {
    parsed = {};
  }

  if (!response.ok) {
    throw new ApiError(response.status, parsed as ApiErrorBody);
  }

  return parsed as T;
}

// Convenience HTTP-verb wrappers.
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