// apps/web/server/push.server.ts — push notification dispatcher.
//
// Phase 2 (this commit): real Web Push via the `web-push` library + APNs
// via apps/web/server/apns.server.ts. The stub that lived here before
// Phase 2 just logged. Now each call fans out to every active
// subscription for the user, dispatching via the right channel:
//
//   platform = 'web'  -> Web Push (VAPID-signed payload to the push
//                        service URL — FCM for Chrome, Mozilla autopush
//                        for Firefox, etc.)
//   platform = 'ios'  -> APNs via the HTTP/2 + JWT client in
//                        apns.server.ts. Required because WKWebView does
//                        NOT support the Web Push API on iOS, so the iOS
//                        app needs a separate channel even though it
//                        loads the same web code as the browser.
//
// Subscription table: `push_subscriptions` in packages/db/src/schema.ts
// (see migration 0015 for the APNs columns added in Phase 2).
//
// Failure handling:
//   - 404 / 410 from Web Push  -> delete the subscription (push service
//                                 confirmed the endpoint is gone)
//   - 410 Gone from APNs       -> same; delete the iOS row
//   - 400 BadDeviceToken       -> same; the device token is malformed
//                                 (the app sent garbage)
//   - All other failures       -> log at warn, leave the subscription;
//                                 transient failures shouldn't kick
//                                 users off push.
//
// Caller-facing contract unchanged from Phase 1 — see the stub comment
// at the top of notifications.server.ts for the integration shape.

import webpush from 'web-push';
import { and, eq, sql } from 'drizzle-orm';
import { pushSubscriptions, withUserContext } from '@edusupervise/db';
import { getDb } from './db.server';
import { logger } from './logger.server';
import { sendApnsPush } from './apns.server';

export interface PushPayload {
  title: string;
  body: string | null;
  linkUrl: string | null;
  tag: string | null;
  data: Record<string, unknown>;
}

interface Subscription {
  id: string;
  platform: 'web' | 'ios';
  // web fields
  endpoint?: string | null;
  p256dh?: string | null;
  auth?: string | null;
  userAgent?: string | null;
  // ios fields
  apnsToken?: string | null;
  apnsBundleId?: string | null;
}

let vapidConfigured = false;

/**
 * Configure VAPID once at module load. `web-push` is a singleton-style
 * library — its module-level `setVapidDetails` mutates state for all
 * subsequent `sendNotification` calls.
 */
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@edusupervise.ashbi.ca';
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export async function sendPushToUser(
  userId: string,
  schoolId: string,
  payload: PushPayload,
): Promise<void> {
  const db = getDb();
  const subs = await withUserContext(db, schoolId, userId, async (tx) => {
    return tx
      .select({
        id: pushSubscriptions.id,
        platform: pushSubscriptions.platform,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
        userAgent: pushSubscriptions.userAgent,
        apnsToken: pushSubscriptions.apnsToken,
        apnsBundleId: pushSubscriptions.apnsBundleId,
      })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.schoolId, schoolId),
          eq(pushSubscriptions.userId, userId),
        ),
      );
  });

  if (subs.length === 0) {
    logger.debug(
      { userId, schoolId },
      'push.dispatch: no subscriptions, skipping',
    );
    return;
  }

  const jsonPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    linkUrl: payload.linkUrl,
    tag: payload.tag,
    data: payload.data,
  });

  // Fan out in parallel — independent failures shouldn't block each other.
  await Promise.allSettled(
    subs.map((sub) => dispatchOne(sub as Subscription, jsonPayload)),
  );
}

async function dispatchOne(sub: Subscription, jsonPayload: string): Promise<void> {
  if (sub.platform === 'web') return dispatchWeb(sub, jsonPayload);
  if (sub.platform === 'ios') return dispatchIos(sub, jsonPayload);
  logger.warn({ subId: sub.id }, 'push.dispatch: unknown platform');
}

async function dispatchWeb(sub: Subscription, jsonPayload: string): Promise<void> {
  if (!sub.endpoint || !sub.p256dh || !sub.auth) {
    logger.warn({ subId: sub.id }, 'push.dispatch: web row missing VAPID fields');
    return;
  }
  if (!ensureVapidConfigured()) {
    logger.warn(
      { subId: sub.id },
      'push.dispatch: VAPID not configured, skipping web push',
    );
    return;
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      jsonPayload,
      { TTL: 60 * 60 }, // 1h — matches Apple's APNs default
    );
    logger.info({ subId: sub.id }, 'push.web: delivered');
  } catch (err: unknown) {
    const statusCode =
      typeof err === 'object' && err && 'statusCode' in err
        ? (err as { statusCode?: number }).statusCode
        : undefined;
    if (statusCode === 404 || statusCode === 410) {
      logger.info(
        { subId: sub.id, statusCode },
        'push.web: endpoint gone, deleting subscription',
      );
      await deleteSubscription(sub.id);
      return;
    }
    logger.warn(
      { subId: sub.id, statusCode, err: String(err) },
      'push.web: delivery failed',
    );
  }
}

async function dispatchIos(sub: Subscription, jsonPayload: string): Promise<void> {
  if (!sub.apnsToken) {
    logger.warn({ subId: sub.id }, 'push.dispatch: ios row missing apns_token');
    return;
  }
  const parsed = JSON.parse(jsonPayload) as PushPayload;
  const result = await sendApnsPush(sub.apnsToken, {
    title: parsed.title,
    body: parsed.body,
    data: {
      ...parsed.data,
      linkUrl: parsed.linkUrl,
      tag: parsed.tag,
    },
  });
  if (result.ok) {
    logger.info({ subId: sub.id, apnsId: result.apnsId }, 'push.ios: delivered');
    return;
  }
  if (result.reason === 'gone' || result.reason === 'invalid-token') {
    logger.info(
      { subId: sub.id, reason: result.reason, status: result.status },
      'push.ios: token dead, deleting subscription',
    );
    await deleteSubscription(sub.id);
    return;
  }
  logger.warn(
    { subId: sub.id, reason: result.reason, status: result.status },
    'push.ios: delivery failed',
  );
}

async function deleteSubscription(id: string): Promise<void> {
  const db = getDb();
  // The runtime role can delete via withUserContext — pass school_id via
  // a join since we only have id. Cheaper: use a system-role brief here.
  await db.execute(sql`DELETE FROM push_subscriptions WHERE id = ${id}`);
}

/**
 * Register or refresh a Web Push subscription. Idempotent on (school,
 * user, endpoint) — duplicate POSTs refresh last_used_at.
 *
 * Called from POST /api/push/register when the browser SW registers.
 */
export async function registerWebSubscription(input: {
  schoolId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<void> {
  const db = getDb();
  await withUserContext(db, input.schoolId, input.userId, async (tx) => {
    await tx
      .insert(pushSubscriptions)
      .values({
        schoolId: input.schoolId,
        userId: input.userId,
        platform: 'web',
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: [
          pushSubscriptions.schoolId,
          pushSubscriptions.userId,
          pushSubscriptions.endpoint,
        ],
        set: {
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
          lastUsedAt: new Date(),
        },
      });
  });
}

/**
 * Register or refresh an APNs device token. Idempotent on (school, user,
 * apnsToken) — re-registering the same token upserts.
 *
 * Called from POST /api/push/register when the iOS Capacitor shell
 * returns a device token via @capacitor/push-notifications.
 */
export async function registerIosSubscription(input: {
  schoolId: string;
  userId: string;
  apnsToken: string;
  apnsBundleId: string;
  apnsAppVersion?: string;
}): Promise<void> {
  const db = getDb();
  await withUserContext(db, input.schoolId, input.userId, async (tx) => {
    await tx
      .insert(pushSubscriptions)
      .values({
        schoolId: input.schoolId,
        userId: input.userId,
        platform: 'ios',
        apnsToken: input.apnsToken,
        apnsBundleId: input.apnsBundleId,
        apnsAppVersion: input.apnsAppVersion ?? null,
      })
      .onConflictDoUpdate({
        target: [
          pushSubscriptions.schoolId,
          pushSubscriptions.userId,
          pushSubscriptions.apnsToken,
        ],
        set: {
          apnsBundleId: input.apnsBundleId,
          apnsAppVersion: input.apnsAppVersion ?? null,
          lastUsedAt: new Date(),
        },
      });
  });
}

export function isVapidReady(): boolean {
  return ensureVapidConfigured();
}

export function isApnsReady(): boolean {
  return Boolean(
    process.env.APNS_KEY_ID &&
      process.env.APNS_TEAM_ID &&
      process.env.APNS_BUNDLE_ID &&
      process.env.APNS_KEY_P8,
  );
}