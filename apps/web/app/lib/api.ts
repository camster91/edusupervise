// apps/web/app/lib/api.ts — fetch wrapper for mutation calls.
//
// Thin wrapper around `csrfFetch` (apps/web/app/lib/csrf.ts) that:
//   - Defaults to `credentials: 'same-origin'` so the session cookie
//     travels with every request.
//   - Parses JSON responses and surfaces server errors as exceptions.
//   - Treats 204 No Content as success-with-null.
//
// Routes that need raw fetch (file uploads, streaming) should NOT use
// this wrapper — call `csrfFetch` directly with `body: FormData` and let
// the browser set the multipart boundary.

import { csrfFetch } from './csrf';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  /** Body — JSON-encoded automatically unless already a string. */
  body?: unknown;
  /**
   * If true, throw ApiError on any 4xx/5xx. Default true.
   */
  throwOnError?: boolean;
}

export async function api<T = unknown>(
  url: string,
  options: ApiOptions = {},
): Promise<T | null> {
  const { body, throwOnError = true, headers, ...rest } = options;

  const init: RequestInit = {
    credentials: 'same-origin',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(body !== undefined && !(body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(headers ?? {}),
    },
  };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
      // Multipart sets its own content-type with boundary.
      delete (init.headers as Record<string, string>)['content-type'];
    } else if (typeof body === 'string') {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }

  const response = await csrfFetch(url, init);

  // No content.
  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') ?? '';
  let parsed: unknown = null;
  if (contentType.includes('application/json')) {
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
  } else {
    try {
      parsed = await response.text();
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (throwOnError) {
      throw new ApiError(
        response.status,
        parsed,
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : undefined,
      );
    }
  }

  return parsed as T;
}