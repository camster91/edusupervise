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

const bodySchema = z.object({
  // Optional override — defaults to the caller's own userId. Reserved
  // for future "notify another user" workflows (e.g. test broadcast).
  userId: z.string().uuid().optional(),
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

  const targetUserId = body.userId ?? session.userId;

  // school_admin can only target themselves — targeting another
  // user in the same tenant could be a social-engineering vector.
  // If we ever need to broadcast test pushes for QA, scope that to a
  // separate elevated endpoint with a stronger audit trail.
  if (targetUserId !== session.userId) {
    return Response.json(
      {
        error: 'forbidden',
        detail: 'Admins can only fire test pushes on themselves. Omit userId or log in as the target user.',
      },
      { status: 403 },
    );
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
    return Response.json({ ok: true, targetUserId });
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