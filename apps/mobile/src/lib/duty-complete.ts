// apps/mobile/src/lib/duty-complete.ts
//
// markDutyComplete — single-tap "Mark complete" helper for the
// Today screen. Mirrors apps/web/app/routes/app.api.duty.complete.ts:
//
//   - POST /app/api/duty.complete
//   - Body: form-encoded (matches web). RN fetch with
//     'Content-Type: application/x-www-form-urlencoded' and a
//     URLSearchParams body is the cleanest path; no JSON.parse
//     dance on the server.
//   - CSRF: 'csrf' field. The token comes from the
//     __Host-edusupervise.csrf cookie persisted in expo-secure-store
//     (slice A's auth.ts exposes getCsrfToken()). api.post also
//     auto-attaches the x-csrf-token header from the same store
//     (double-submit defense-in-depth per csrf.server.ts).
//   - Returns 204 on success, 401 on session expiry, 403 if the
//     user is an educational_assistant, 400 on missing/invalid
//     dutyId, 500 on internal failure.
//
// We use slice A's `api.post()` which returns an envelope
// { status, data, ok } — never throws. The wrapper here translates
// that envelope into a discriminated result the Today screen +
// useToday hook can branch on without try/catch noise at every
// call site.

import { api, getApiBaseUrl } from './api';
import { getCsrfToken } from './auth';

export type MarkCompleteResult =
  | { ok: true; dutyId: string }
  | { ok: false; dutyId: string; status: number; reason: string };

/**
 * Submit a "mark complete" for one duty. Optimistic: the caller
 * (useToday hook) flips the duty's local state BEFORE this resolves
 * and rolls back on a non-204 result.
 */
export async function markDutyComplete(
  dutyId: string,
): Promise<MarkCompleteResult> {
  if (!dutyId || typeof dutyId !== 'string') {
    return { ok: false, dutyId, status: 0, reason: 'invalid_duty_id' };
  }

  const csrfToken = await getCsrfToken();
  if (!csrfToken) {
    return { ok: false, dutyId, status: 0, reason: 'missing_csrf' };
  }

  // URLSearchParams → string. We pre-stringify because api.post
  // serializes any non-FormData/Blob/ArrayBuffer/string body via
  // JSON.stringify, which would corrupt a URLSearchParams instance
  // (see apps/mobile/src/lib/api.ts). When body is a string, api.post
  // passes it through unchanged.
  const body = new URLSearchParams();
  body.set('csrf', csrfToken);
  body.set('dutyId', dutyId);
  const bodyString = body.toString();

  const res = await api.post<unknown>(`${getApiBaseUrl()}/app/api/duty.complete`, bodyString, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (res.status === 204) {
    return { ok: true, dutyId };
  }

  // Map known failure modes to a human reason. We don't show the
  // raw server text in the UI — slice B's Today screen maps each
  // reason to a Toast/Snackbar copy.
  let reason = 'unknown';
  const code = (res.data as { error?: string } | null)?.error;
  if (res.status === 401) reason = 'session_expired';
  else if (res.status === 403) reason = 'ea_coverage_flow';
  else if (res.status === 400) reason = code || 'bad_request';
  else if (res.status === 500) reason = 'server_error';
  else if (res.status === 0) reason = 'network_error';

  return { ok: false, dutyId, status: res.status, reason };
}
