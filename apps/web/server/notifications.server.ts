// apps/web/server/notifications.server.ts — in-app notifications + push.
//
// Integration point for in-app notifications + browser push.
//
// Contract:
//   sendNotification({ schoolId, userId, kind, title, body?, linkUrl?, data? })
//     -> Promise<void>
//
// Tier 2 (this commit) ships Web Push integration: every notification
// is also pushed to the user's registered browser subscriptions if any.
//
// RLS: the INSERT runs inside `withUserContext` so the runtime role's
// FORCE RLS policy on `notifications` admits the write.
//
// Pool leak fix (2026-06-30, audit RED-1): the previous version had a
// local `getDb()` that called `getRuntimeClient(url)` on every send —
// each call created a fresh 10-socket pool that was never closed.
// Now we reuse the cached singleton from `db.server.ts#getDb()`.

import { notifications, withUserContext } from '@edusupervise/db';

import { logger } from './logger.server';
import { getDb } from './db.server';
import { sendPushToUser } from './push.server';

export type NotificationKind =
  | 'reminder.failed'
  | 'plan.downgrade.pending'
  | 'plan.downgrade.applied'
  | 'system.message';

export interface SendNotificationInput {
  schoolId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  linkUrl?: string;
  data?: Record<string, unknown>;
}

/**
 * Insert an in-app notification for the user, then push to any
 * registered browser push subscriptions. Web Push failures are
 * swallowed (logged at warn) — the in-app notification is the
 * canonical record, push is best-effort.
 */
export async function sendNotification(input: SendNotificationInput): Promise<void> {
  const db = getDb();
  await withUserContext(db, input.schoolId, input.userId, async (tx) => {
    await tx.insert(notifications).values({
      schoolId: input.schoolId,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      linkUrl: input.linkUrl ?? null,
    });
  });
  logger.info(
    { schoolId: input.schoolId, userId: input.userId, kind: input.kind },
    'notification: created',
  );

  // Best-effort browser push. Wrapped in try/finally so a push
  // failure doesn't surface to the caller (the in-app notification
  // already succeeded). The push helper itself returns void and
  // logs internal failures; this catch is for unexpected throws
  // (e.g. VAPID key misconfigured at boot).
  try {
    await sendPushToUser(input.userId, input.schoolId, {
      title: input.title,
      body: input.body ?? null,
      linkUrl: input.linkUrl ?? null,
      tag: input.kind,
      data: { kind: input.kind, ...(input.data ?? {}) },
    });
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, kind: input.kind },
      'notification: push failed (non-fatal)',
    );
  }
}