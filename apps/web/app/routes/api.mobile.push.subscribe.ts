// apps/web/app/routes/api.mobile.push.subscribe.ts
//
// POST /api/mobile/push/subscribe — register (or refresh) the
// caller's Expo push token.
//
// Auth: getSession() required. The session cookie is the same
// `edusupervise.session` cookie the web app uses; the mobile app
// stores it in expo-secure-store and replays it on every request
// (see docs/superpowers/specs/2026-07-06-edusupervise-mobile-mvp.md §4).
//
// CSRF: REQUIRED on this endpoint (security review E-008, 2026-07-06).
//
//   The double-submit cookie check is the canonical CSRF guard for
//   state-changing routes. The mobile client does one extra GET on
//   first launch (e.g. GET /app/today) to populate the CSRF cookie
//   via `ensureCsrfCookie` (csrf.server.ts:206-214). The cookie
//   persists in expo-secure-store for the session lifetime; every
//   subsequent mutation reads it back and sends it as the
//   `csrf` body field. (The server's `validateCsrfFromJson` accepts
//   the token in the JSON body, not a header — see the helper
//   docstring at csrf.server.ts:374-394.)
//
//   We considered exempting this endpoint on the grounds that the
//   mobile app "isn't a browser" and there's no cross-origin form
//   attack surface. The auditor disagreed (E-008): treating mutation
//   endpoints uniformly is a stronger invariant, and the cost (one
//   extra GET on first launch) is negligible. The CSRF cookie is
//   also already part of the secure-store payload slice A's auth
//   flow writes, so no new storage is required.
//
// Body: { csrf, expoPushToken, deviceId?, appVersion?, platform: 'ios'|'android' }
//
// Idempotency:
//   UNIQUE(school_id, user_id, expo_push_token) (security review
//   E-004) means a re-subscribe from the same device (e.g. on every
//   app launch) just refreshes `last_seen_at` and clears any prior
//   `revoked_at`. The route uses `ON CONFLICT ... DO UPDATE` to make
//   this a single round-trip and avoid the duplicate-key error that
//   would otherwise surface to the client.
//
// Response: 204 No Content (the in-app notification inbox / device
//   count is the user's source of truth; we don't echo the row back).

import type { Route } from './+types/api.mobile.push.subscribe';
import { z } from 'zod';
import { getSession } from '../../server/auth.server';
import { getDb } from '../../server/db.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { logger } from '../../server/logger.server';
import { mobilePushSubscriptions } from '@edusupervise/db';
import { maskToken } from '@edusupervise/push';

const subscribeBodySchema = z.object({
  expoPushToken: z
    .string()
    .min(1)
    .max(255)
    .regex(/^ExponentPushToken\[.+\]$/, {
      message: 'expoPushToken must look like "ExponentPushToken[xxx]"',
    }),
  deviceId: z.string().min(1).max(255).optional(),
  appVersion: z.string().min(1).max(64).optional(),
  platform: z.enum(['ios', 'android']),
});

export async function loader() {
  // GET on this POST-only endpoint — likely a typo or a probe. Return
  // 405 with a hint rather than redirecting to /login (which would
  // not make sense for a JSON API).
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  // 1. Parse the body FIRST (we need the csrf field for validation;
  //    validateCsrfFromJson reads it from the body, not a header).
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: 'malformed_json' },
      { status: 400 },
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json(
      { error: 'invalid_body' },
      { status: 400 },
    );
  }
  const body = raw as Record<string, unknown>;

  // 2. CSRF check (Layer 1: origin/referer; Layer 2: cookie + body.csrf).
  //    This runs BEFORE the auth check so a CSRF probe can't even
  //    probe for valid session cookies.
  const csrf = validateCsrfFromJson(request, body, { requireOrigin: false });
  if (!csrf.ok) return csrf.response;

  // 3. Auth.
  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 4. Validate the rest of the body.
  const parsed = subscribeBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_body',
        detail: parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  const { expoPushToken, deviceId, appVersion, platform } = parsed.data;

  // 5. UPSERT. We use a single round-trip with ON CONFLICT to keep
  //    the per-launch cost low (the mobile app calls this on every
  //    foreground). The `revoked_at = NULL` clause makes a
  //    re-subscribe from a previously-logged-out device re-enable
  //    pushes without needing a separate "re-enable" call.
  //
  //    Conflict target is the composite UNIQUE
  //    (school_id, user_id, expo_push_token) per migration 0015.
  //    The partial index `idx_mobile_push_subscriptions_school_user_active`
  //    covers the dispatch lookup.
  //
  //    Note: we don't set `app.school_id` here because the runtime
  //    role's FORCE RLS on this table filters by the row's
  //    school_id. The session's schoolId is the canonical source of
  //    truth for "which school does this user belong to" — we trust
  //    it implicitly. Defense-in-depth is the RLS policy itself
  //    (school_id = current_school_id() must match the session's
  //    school, or the insert is rejected).
  const db = getDb();
  try {
    await db
      .insert(mobilePushSubscriptions)
      .values({
        schoolId: session.schoolId,
        userId: session.userId,
        expoPushToken,
        platform,
        deviceId: deviceId ?? null,
        appVersion: appVersion ?? null,
        lastSeenAt: new Date(),
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          mobilePushSubscriptions.schoolId,
          mobilePushSubscriptions.userId,
          mobilePushSubscriptions.expoPushToken,
        ],
        set: {
          // Refresh last_seen_at + clear revoked_at (handles the
          // "re-subscribe after logout" case). Platform / deviceId /
          // appVersion are refreshed too in case the user reinstalled
          // and got a new deviceId, or upgraded the app.
          lastSeenAt: new Date(),
          revokedAt: null,
          platform,
          deviceId: deviceId ?? null,
          appVersion: appVersion ?? null,
        },
      });
  } catch (err) {
    // RLS violation (session.schoolId doesn't match current_school_id
    // — only happens if a different code path set the GUC wrong) or
    // a transient DB error. We log + 500; the mobile app retries on
    // the next foreground.
    logger.error(
      { err, userId: session.userId, schoolId: session.schoolId },
      'mobile-push.subscribe: insert failed',
    );
    return Response.json(
      { error: 'internal' },
      { status: 500 },
    );
  }

  logger.info(
    {
      userId: session.userId,
      schoolId: session.schoolId,
      platform,
      // Mask the token in logs (PII).
      token: maskToken(expoPushToken),
    },
    'mobile-push.subscribe: registered',
  );

  return new Response(null, { status: 204 });
}
