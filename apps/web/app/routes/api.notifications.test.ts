// apps/web/app/routes/api.notifications.test.ts — fire a test notification.
//
// Admin-only POST endpoint that lets a school_admin (or higher role)
// verify the push-notification pipeline end-to-end. The notification
// is dispatched via the same notifications.server.ts#sendNotification
// surface used by the worker reminder queue — same code path, same
// role gating, same audit row.
//
// Behavior:
//   - Default target = the calling session's own userId (admins can
//     test on themselves first, then point at another user).
//   - The `kind` field defaults to `system.message` to avoid surfacing
//     a fake "reminder.failed" in user inboxes — the value is shown
//     only as the push payload tag.
//   - Same audit_log row written as production notifications.
//   - Rate-limited to 10 calls per user per hour.
//
// This route is intentionally NOT feature-gated behind a flag — every
// production deployment ships with it. It's the operator's eye-glass
// when Web Push or APNs delivery degrades.
//
// When to delete: probably never. The surface is small (admin-only,
// rate-limited) and the diagnostic value outweighs the minimal attack
// surface. If you must remove it, also rip out the underlying
// notifications.server.ts#sendNotification test paths in client code.

import { z } from 'zod';
import type { Route } from './+types/api.notifications.test';
import { getSession, requireRole, requireSession } from '../../server/auth.server';
import { check } from '../../server/rate-limit.server';
import { sendNotification } from '../../server/notifications.server';
import { logger } from '../../server/logger.server';
import { getSystemDb } from '../../server/db.server';

const MAX_BROADCAST_RECIPIENTS = 100;

const bodySchema = z.object({
  // Optional override — defaults to the caller's own userId. Reserved
  // for future "notify another user" workflows (e.g. test broadcast).
  userId: z.string().uuid().optional(),
  // When true, broadcast to every school_admin in the caller's school
  // (capped at MAX_BROADCAST_RECIPIENTS). Mutually exclusive with userId.
  targetAllAdmins: z.boolean().optional(),
  title: z.string().min(1).max(120),
  body: z.string().max(500).optional(),
  linkUrl: z.string().max(500).optional(),
  // Defaults to 'system.message' so a test doesn't show up as a real
  // reminder in the user's in-app inbox. Use 'reminder.failed' (etc.)
  // only when intentionally testing the worker queue's integration.
  kind: z
    .enum([
      'reminder.failed',
      'plan.downgrade.pending',
      'plan.downgrade.applied',
      'system.message',
    ])
    .default('system.message'),
});

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
  // school_admin only — teachers cannot fire arbitrary pushes.
  const session = requireRole(maybeSession, ['school_admin']);

  const rl = check({
    key: `notifications_test:user:${session.userId}`,
    max: 10,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec ?? 60) } },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await request.json();
    body = bodySchema.parse(raw);
  } catch (err) {
    return Response.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  // Mutual exclusion: targetAllAdmins OR userId, not both.
  if (body.targetAllAdmins && body.userId) {
    return Response.json(
      { error: 'invalid_request', detail: 'targetAllAdmins and userId are mutually exclusive' },
      { status: 400 },
    );
  }

  // ----- Broadcast path: send to every school_admin in this school.
  if (body.targetAllAdmins) {
    const { users: usersTable } = await import('@edusupervise/db');
    const { eq, and, inArray } = await import('drizzle-orm');
    const sysDb = getSystemDb();
    const adminRows = await sysDb
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.schoolId, session.schoolId),
          inArray(usersTable.role, ['school_admin']),
        ),
      )
      .limit(MAX_BROADCAST_RECIPIENTS);

    if (adminRows.length === 0) {
      return Response.json(
        { error: 'no_recipients', detail: 'No school_admins found in this school.' },
        { status: 404 },
      );
    }
    if (adminRows.length === MAX_BROADCAST_RECIPIENTS) {
      logger.warn(
        { actor: session.userId, schoolId: session.schoolId, cap: MAX_BROADCAST_RECIPIENTS },
        'notifications.test: broadcast hit recipient cap; remaining admins not notified',
      );
    }

    // Fan out in parallel; one recipient's failure must NOT abort the rest.
    const results = await Promise.allSettled(
      adminRows.map((row) =>
        sendNotification({
          schoolId: session.schoolId,
          userId: row.id,
          kind: body.kind,
          title: body.title,
          body: body.body,
          linkUrl: body.linkUrl,
          data: { source: 'api.notifications.test:broadcast', ts: Date.now() },
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    const failedUserIds = results
      .map((r, i) => (r.status === 'rejected' ? adminRows[i]?.id : null))
      .filter((id): id is string => id !== null);

    logger.info(
      {
        actor: session.userId,
        mode: 'broadcast',
        recipients: results.length,
        succeeded,
        failed,
        kind: body.kind,
        title: body.title,
      },
      'notifications.test: broadcast fired',
    );

    return Response.json({
      ok: failed === 0,
      mode: 'broadcast',
      recipients: results.length,
      succeeded,
      failed,
      failedUserIds,
      cappedAt: adminRows.length === MAX_BROADCAST_RECIPIENTS ? MAX_BROADCAST_RECIPIENTS : null,
    });
  }

  // ----- Single-recipient path (default).
  const targetUserId = body.userId ?? session.userId;

  // When targeting a different user, verify they exist in the
  // caller's school. This prevents admins from spamming arbitrary
  // userIds (the FK on notifications would error out, but the
  // 404 here is a cleaner signal + cheaper than a transaction
  // abort).
  if (targetUserId !== session.userId) {
    const { users: usersTable } = await import('@edusupervise/db');
    const { eq, and } = await import('drizzle-orm');
    const { getSystemDb } = await import('../../server/db.server');
    const sysDb = getSystemDb();
    const [found] = await sysDb
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(eq(usersTable.id, targetUserId), eq(usersTable.schoolId, session.schoolId)),
      )
      .limit(1);
    if (!found) {
      return Response.json(
        { error: 'not_found', detail: 'Target user not found in this school.' },
        { status: 404 },
      );
    }
  }

  try {
    await sendNotification({
      schoolId: session.schoolId,
      userId: targetUserId,
      kind: body.kind,
      title: body.title,
      body: body.body,
      linkUrl: body.linkUrl,
      data: { source: 'api.notifications.test', ts: Date.now() },
    });
    logger.info(
      {
        actor: session.userId,
        target: targetUserId,
        kind: body.kind,
        title: body.title,
      },
      'notifications.test: fired',
    );
    return Response.json({ ok: true, mode: 'single', targetUserId });
  } catch (err) {
    logger.error({ err, actor: session.userId }, 'notifications.test: failed');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function loader() {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}