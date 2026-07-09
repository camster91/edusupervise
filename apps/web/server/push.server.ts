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
import { sendApnsPush, getApnsConfig } from './apns.server';

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
  // Carried so deleteSubscription can pass school_id + user_id to
  // withUserContext and satisfy the FORCE RLS policy on
  // push_subscriptions. Without these, the DELETE was silently denied
  // (RLS policy evaluated `school_id = NULL` → FALSE) and dead tokens
  // accumulated forever. Audited 2026-07-09.
  schoolId: string;
  userId: string;
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
        schoolId: pushSubscriptions.schoolId,
        userId: pushSubscriptions.userId,
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

  // Fan out in parallel — independent failures shouldn't block each other.
  // Pass the structured PushPayload directly; previously each dispatch
  // round-tripped through JSON.stringify + JSON.parse (audit #5 — wasted
  // parse + unsafe cast). Promise.allSettled rejections are now logged
  // with an explicit "cleanup.delete failed" tag so operators can grep
  // cleanup failures distinct from delivery failures.
  const results = await Promise.allSettled(
    subs.map((sub) => dispatchOne(sub as Subscription, payload)),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.warn(
        { subId: subs[i]?.id, err: r.reason instanceof Error ? r.reason.message : String(r.reason) },
        'push.dispatch: cleanup.delete failed',
      );
    }
  });
}

async function dispatchOne(sub: Subscription, payload: PushPayload): Promise<void> {
  if (sub.platform === 'web') return dispatchWeb(sub, payload);
  if (sub.platform === 'ios') return dispatchIos(sub, payload);
  logger.warn({ subId: sub.id }, 'push.dispatch: unknown platform');
}

async function dispatchWeb(sub: Subscription, payload: PushPayload): Promise<void> {
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
    // web-push accepts JSON-stringified payload. Build the wire format
    // here (was previously done in sendPushToUser + reparsed per recipient).
    const wireJson = JSON.stringify({
      title: payload.title,
      body: payload.body,
      linkUrl: payload.linkUrl,
      tag: payload.tag,
      data: payload.data,
    });
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      wireJson,
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
      await deleteSubscription(sub.id, sub.schoolId, sub.userId);
      return;
    }
    logger.warn(
      { subId: sub.id, statusCode, err: String(err) },
      'push.web: delivery failed',
    );
  }
}

async function dispatchIos(sub: Subscription, payload: PushPayload): Promise<void> {
  if (!sub.apnsToken) {
    logger.warn({ subId: sub.id }, 'push.dispatch: ios row missing apns_token');
    return;
  }
  // Validate the registered bundle ID matches what the server is configured
  // to send. A token registered for a different bundle (stale row from
  // re-install or bundle-id change) would silently misroute. Drop a
  // logger.warn and skip the send; the stale row will be cleaned up on
  // the next dispatch that returns 'gone' or 'invalid-token'.
  const cfg = getApnsConfig();
  if (cfg && sub.apnsBundleId && sub.apnsBundleId !== cfg.bundleId) {
    logger.warn(
      {
        subId: sub.id,
        registeredBundle: sub.apnsBundleId,
        serverBundle: cfg.bundleId,
      },
      'push.ios: bundle mismatch, skipping stale subscription',
    );
    return;
  }
  const result = await sendApnsPush(sub.apnsToken, {
    title: payload.title,
    body: payload.body,
    data: {
      ...payload.data,
      linkUrl: payload.linkUrl,
      tag: payload.tag,
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
    await deleteSubscription(sub.id, sub.schoolId, sub.userId);
    return;
  }
  logger.warn(
    { subId: sub.id, reason: result.reason, status: result.status },
    'push.ios: delivery failed',
  );
}

/**
 * Delete a single push subscription row.
 *
 * MUST be called with the row's schoolId + userId so we can wrap the
 * DELETE in withUserContext — without that, FORCE RLS on
 * push_subscriptions evaluates `school_id = current_school_id()` (NULL
 * on a fresh pool connection) → FALSE and the DELETE silently matches
 * zero rows. Dead tokens then accumulate indefinitely and the
 * dispatcher keeps retrying them. Audited 2026-07-09.
 */
async function deleteSubscription(
  id: string,
  schoolId: string,
  userId: string,
): Promise<void> {
  await withUserContext(getDb(), schoolId, userId, async (tx) => {
    await tx.execute(sql`DELETE FROM push_subscriptions WHERE id = ${id}`);
  });
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

