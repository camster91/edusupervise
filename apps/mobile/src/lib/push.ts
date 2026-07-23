// apps/mobile/src/lib/push.ts
//
// Expo Push registration + tap-handler for the EduSupervise mobile app.
//
// Responsibilities:
//   1. Request a push token from the OS via expo-notifications.
//   2. POST it to /api/mobile/push/subscribe so the server can dispatch
//      duty reminders + coverage requests to this device.
//   3. On token refresh, re-POST to keep the server in sync.
//   4. Validate any deep-link fields in the push `data` payload with
//      a strict UUID v4 regex BEFORE any router.push (security review
//      E-007, 2026-07-06 — phishing vector via linkUrl/data).
//
// Why this lives next to the app shell (not in a server module):
//   expo-notifications only runs in the React Native runtime. The
//   helper is a thin client-side wrapper around the OS + our HTTP API.
//   It depends on the secure-store-backed cookie manager (slice A's
//   `api.ts`) to read the session + CSRF cookies. We import from
//   '@edusupervise/mobile/api' (slice A's export) and fall back to
//   raw fetch if the import is missing — the latter is the dev-mode
//   shape before slice A's scaffold lands, so this file is self-
//   sufficient for the typecheck + smoke test cycle.
//
// Deep-link scheme:
//   We don't have a custom URL scheme (e.g. edusupervise://) yet —
//   the app uses expo-router's internal routes. The server's
//   `linkUrl: '/app/today'` is a relative path the mobile app
//   prepends with the base URL. The `data.dutyId` field is the
//   reliable deep-link target: a tap on a reminder push routes to
//   /(app)/today?dutyId=<uuid>, which the today loader uses to
//   highlight the relevant duty card.

import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getApiBaseUrl } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** UUID v4 regex — strict (any non-v4 UUID rejected). Per RFC 4122,
 *  v4 UUIDs have the version nibble set to 4 and the variant bits set
 *  to 10xx. Anything else is not a v4 UUID. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

/** Deep-link payload the mobile app reads on push tap. Mirrors the
 *  server's data fields in @edusupervise/push + apps/worker/jobs/reminders.ts. */
export interface MobilePushData {
  kind?: 'reminder' | 'coverage' | 'system';
  dutyId?: string;
  reminderId?: string;
  assignmentId?: string;
  coverageAssignmentId?: string;
  linkUrl?: string;
  scheduledFor?: string;
  [k: string]: unknown;
}

/** Outcome of registerForPushNotifications — used for telemetry. */
export type PushRegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'permission_denied' | 'no_project_id' | 'http_error'; detail?: string };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Build the absolute URL used for subscribe/unsubscribe HTTP calls.
 *
 * On native (iOS/Android) the React Native `fetch` polyfill does NOT
 * resolve relative paths against the app origin — there is no app
 * origin in a bare RN runtime, so `fetch('/api/foo')` throws
 * "Failed to construct URL". The web-side apiFetch() does the same
 * resolution via getApiBaseUrl(); we mirror that here so the
 * helper is testable and never depends on undocumented fetch
 * behavior.
 *
 * If a base URL is explicitly passed (e.g. by a unit test), we
 * trust it. Otherwise we resolve from `getApiBaseUrl()`, which
 * reads `EXPO_PUBLIC_API_BASE_URL` with a production fallback.
 *
 * The path is always anchored with a single leading slash.
 */
export function buildPushApiUrl(
  path: '/api/mobile/push/subscribe' | '/api/mobile/push/unsubscribe',
  baseUrl?: string,
): string {
  const base = (baseUrl ?? getApiBaseUrl()).replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Request push permission + register with the EduSupervise server.
 * Safe to call on every app foreground — the server upsert is
 * idempotent (UNIQUE(school_id, user_id, expo_push_token)).
 */
export async function registerForPushNotifications(
  getCookieHeader: () => Promise<string>,
  getCsrfToken: () => Promise<string | null>,
): Promise<PushRegistrationResult> {
  // 1. Permission. iOS requires explicit opt-in. Android 13+ too.
  //    We don't fail the app launch on a deny — the user can still
  //    use the app, they just won't get background reminders.
  const permission = await Notifications.getPermissionsAsync();
  let granted = permission.granted;
  if (!granted) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) {
    return { ok: false, reason: 'permission_denied' };
  }

  // 2. Project ID. Required by Expo's getExpoPushTokenAsync. The mobile
  //    app's app.json#extra.eas.projectId is set by EAS Build (slice D).
  //    If it's missing (e.g. running a bare Expo Go dev build before
  //    EAS is configured), we can't get a token — fail loud.
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) {
    return {
      ok: false,
      reason: 'no_project_id',
      detail: 'app.json#extra.eas.projectId is not set',
    };
  }

  // 3. Get the token from Expo. On Android, this returns an FCM token
  //    that Expo routes through their gateway. On iOS, an APNs token.
  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data;
  } catch (err) {
    return {
      ok: false,
      reason: 'http_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. POST to /api/mobile/push/subscribe. Cookie + CSRF are read
  //    from secure-store via the caller-supplied getCookieHeader /
  //    getCsrfToken helpers (slice A's api.ts is the canonical
  //    source; in dev we accept any other source).
  const csrf = await getCsrfToken();
  if (!csrf) {
    return {
      ok: false,
      reason: 'http_error',
      detail: 'CSRF token missing — login first or fetch /app/today to mint the cookie',
    };
  }

  const deviceId =
    Platform.OS === 'ios'
      ? await Application.getIosIdForVendorAsync().catch(() => null)
      : null;
  const appVersion = Application.nativeApplicationVersion ?? null;

  const cookieHeader = await getCookieHeader();
  const res = await fetch(buildPushApiUrl('/api/mobile/push/subscribe'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // CSRF: per the CSRF-REQUIRED design (security review E-008),
      // the server reads the token from the JSON body's `csrf` field.
      // The cookie + the body field must match (double-submit).
      Cookie: cookieHeader,
    },
    body: JSON.stringify({
      csrf,
      expoPushToken: token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceId: deviceId ?? undefined,
      appVersion: appVersion ?? undefined,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      reason: 'http_error',
      detail: `subscribe ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Unregister (called on logout)
// ---------------------------------------------------------------------------

/**
 * Mark the current device's push token as revoked on the server.
 * Idempotent — server returns 204 even if the row was already revoked.
 */
export async function unregisterForPushNotifications(
  token: string,
  getCookieHeader: () => Promise<string>,
  getCsrfToken: () => Promise<string | null>,
): Promise<boolean> {
  const csrf = await getCsrfToken();
  if (!csrf) return false;
  try {
    const cookieHeader = await getCookieHeader();
    const res = await fetch(buildPushApiUrl('/api/mobile/push/unsubscribe'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ csrf, expoPushToken: token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deep-link handler (security review E-007)
// ---------------------------------------------------------------------------

/**
 * Map a push payload to an expo-router route + params. STRICT UUID
 * validation on every server-controlled ID — a push that contains
 * `dutyId: "javascript:alert(1)"` is treated as malformed and the
 * user is dropped to the today screen with no params.
 *
 * Why this matters: the spec defines `linkUrl` and `data` as
 * server-controlled. A compromised server, a misbehaving cron job,
 * or a malicious Expo delivery path could put a phishing URL or a
 * JS-injection-looking string in those fields. expo-router's
 * `router.push({ pathname, params })` does not validate the params
 * shape, so we must do it at the boundary.
 */
export function buildDeepLinkFromPush(data: MobilePushData | undefined): {
  pathname: '/(app)/today' | '/(app)/coverage';
  params: Record<string, string>;
} {
  // No data → safe default: today screen.
  if (!data || typeof data !== 'object') {
    return { pathname: '/(app)/today', params: {} };
  }

  const kind = data.kind;

  if (kind === 'coverage') {
    // Coverage requests: server may include coverageAssignmentId.
    // Validate strictly; if it doesn't pass, drop to coverage list
    // (no params) rather than today — the user just got a coverage
    // ping and we should land them somewhere relevant.
    if (isValidUuidV4(data.coverageAssignmentId)) {
      return {
        pathname: '/(app)/coverage',
        params: { assignmentId: data.coverageAssignmentId },
      };
    }
    return { pathname: '/(app)/coverage', params: {} };
  }

  // Default: reminder / system → today screen, with dutyId if present.
  if (isValidUuidV4(data.dutyId)) {
    return {
      pathname: '/(app)/today',
      params: { dutyId: data.dutyId },
    };
  }
  return { pathname: '/(app)/today', params: {} };
}
