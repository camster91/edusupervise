// apps/web/app/routes/api.push.register.ts — register a push subscription.
//
// Two variants in one route, distinguished by the platform claim:
//   - { platform: 'web', subscription: { endpoint, keys: { p256dh, auth } }, userAgent }
//   - { platform: 'ios', apnsToken, apnsBundleId, apnsAppVersion? }
//
// The Web Push flow is called by the browser's service worker after
// `pushManager.subscribe(...)`. The iOS flow is called by the Capacitor
// JS bridge after @capacitor/push-notifications returns a device token.
//
// Both variants require an authenticated session — we resolve the
// school + user from the cookie, then upsert into push_subscriptions.
//
// Rate-limited: 10 calls / user / hour. Re-registering with the same
// token is idempotent (the dispatcher upserts on the unique index).

import { z } from 'zod';
import type { Route } from './+types/api.push.register';
import { requireSession, getSession } from '../../server/auth.server';
import { check } from '../../server/rate-limit.server';
import {
  registerIosSubscription,
  registerWebSubscription,
} from '../../server/push.server';
import { logger } from '../../server/logger.server';
import { validateCsrfFromJson } from '../../server/csrf.server';

const webSchema = z.object({
  platform: z.literal('web'),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
  userAgent: z.string().max(500).optional(),
});

const iosSchema = z.object({
  platform: z.literal('ios'),
  apnsToken: z.string().regex(/^[0-9a-fA-F]{64}$/, 'apnsToken must be 64-char hex'),
  apnsBundleId: z
    .string()
    .min(1)
    .max(200)
    // Reverse-DNS-ish: letters, digits, dot, hyphen. Rejects injection
    // vectors (whitespace, slashes, quotes). Server still uses the env-
    // configured APNS_BUNDLE_ID in the apns-topic header, never this
    // user-supplied value, but the value is logged and validated for
    // hygiene.
    .regex(/^[a-zA-Z0-9.-]+$/, 'apnsBundleId must be reverse-DNS-ish'),
  apnsAppVersion: z.string().max(50).optional(),
});

const bodySchema = z.discriminatedUnion('platform', [webSchema, iosSchema]);

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  const maybeSession = await getSession(request);
  if (!maybeSession) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const session = requireSession(maybeSession);

  const rl = check({
    key: `push_register:user:${session.userId}`,
    max: 10,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec ?? 60) } },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json();
    parsed = bodySchema.parse(raw);
  } catch (err) {
    return Response.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  // CSRF AFTER parse (so we can validate the body field) and BEFORE
  // any state-mutating work. Mirrors api.mobile.push.subscribe.ts:106-107.
  const csrf = validateCsrfFromJson(request, parsed);
  if (!csrf.ok) {
    return csrf.response;
  }

  try {
    if (parsed.platform === 'web') {
      await registerWebSubscription({
        schoolId: session.schoolId,
        userId: session.userId,
        endpoint: parsed.subscription.endpoint,
        p256dh: parsed.subscription.keys.p256dh,
        auth: parsed.subscription.keys.auth,
        userAgent: parsed.userAgent,
      });
      logger.info(
        { userId: session.userId, endpoint: parsed.subscription.endpoint },
        'push.register: web subscription upserted',
      );
    } else {
      await registerIosSubscription({
        schoolId: session.schoolId,
        userId: session.userId,
        apnsToken: parsed.apnsToken,
        apnsBundleId: parsed.apnsBundleId,
        apnsAppVersion: parsed.apnsAppVersion,
      });
      logger.info(
        {
          userId: session.userId,
          bundleId: parsed.apnsBundleId,
          // Don't log the full token — it's a long-lived secret for the device.
          tokenTail: parsed.apnsToken.slice(-8),
        },
        'push.register: ios subscription upserted',
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    logger.error({ err, userId: session.userId }, 'push.register: failed');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function loader() {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}