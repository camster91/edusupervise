// apps/web/server/notifications.server.ts — STUB
//
// Integration point for in-app notifications + browser push. Tier 1
// ships the `notifications` table; Tier 2 (this task) ships Web Push.
// The full notification pipeline (write to `notifications` table + send
// Web Push to the user) is wired here so frontend-reminders has a
// single place to call.
//
// Status: STUB. The frontend-reminders task replaces the body of
// `sendNotification` with the real implementation. Push wiring is
// already in place via apps/web/server/push.server.ts.
//
// Contract:
//   sendNotification({ schoolId, userId, kind, title, body?, linkUrl?, data? })
//     -> Promise<void>
//
// The Tier 1 pipeline (frontend-reminders task) is expected to:
//   1. INSERT a row into `notifications` (RLS via current_school_id()).
//   2. If the user has any registered push subscriptions, also call
//      sendPushToUser(userId, schoolId, payload).
//   3. Update audit_log with action='notification.created'.
//
// Until that lands, this stub does (1) only. The push call is queued
// behind a `TODO` comment so the wiring is obvious to the next reader.

import { getRuntimeClient, notifications, withUserContext } from '@edusupervise/db';
import type { Db } from '@edusupervise/db';

import { logger } from './logger.server';
// Web Push wiring is intentionally imported but not yet called here.
// The frontend-reminders task will add the sendPushToUser() call.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
 * Insert an in-app notification for the user. TODO(frontend-reminders):
 * also call sendPushToUser() so users get a browser push when they
 * have a registered push subscription. See `docs/runbooks/push-debug.md`
 * for the failure-mode checklist (VAPID key, 410 Gone, browser blocks).
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
  // TODO(frontend-reminders):
  //   await sendPushToUser(input.userId, input.schoolId, {
  //     title: input.title,
  //     body: input.body,
  //     linkUrl: input.linkUrl,
  //     tag: input.kind,
  //     data: { kind: input.kind, ...input.data },
  //   });
}

function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'notifications.server: DATABASE_URL is not set. ' +
        'Export DATABASE_URL=postgres://edusupervise_runtime:... and retry.',
    );
  }
  return getRuntimeClient(url).db;
}