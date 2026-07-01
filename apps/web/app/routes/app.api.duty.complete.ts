// apps/web/app/routes/app.api.duty.complete.ts
//
// POST /app/api/duty.complete — single-tap "Mark complete" from the
// Today duty card. v1 implementation:
//
//   1. CSRF check
//   2. Confirm the duty is assigned to the logged-in teacher
//   3. Insert a `notifications` row for the school admin(s)
//      ("Mr. Smith marked Cafeteria Lunch A complete at 11:35")
//   4. Return 204
//
// v2 (when duty_completions table lands):
//   - INSERT INTO duty_completions (duty_id, user_id, completed_at)
//   - Use the completion log for fairness analytics + completion-rate
//     stats on the admin Insights view.
//   - Equipment-check-off flow writes back equipment confirmed/not.

import { redirect } from 'react-router';
import type { Route } from './+types/app.api.duty.complete';
import { and, eq, inArray } from 'drizzle-orm';
import {
  duties,
  dutyAssignments,
  notifications,
  users,
} from '@edusupervise/db';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { validateCsrf } from '../../server/csrf.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return redirect('/app/today');
}

export async function action({ request }: Route.ActionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const form = await request.formData();
  const dutyId = String(form.get('dutyId') ?? '').trim();
  if (!dutyId) {
    return Response.json({ error: 'missing_duty_id' }, { status: 400 });
  }

  try {
    await withSchoolId(session.schoolId, async (tx) => {
      // Confirm the duty exists + is assigned to this teacher.
      const [duty] = await tx
        .select({
          id: duties.id,
          location: duties.location,
          startTime: duties.startTime,
        })
        .from(duties)
        .where(eq(duties.id, dutyId))
        .limit(1);

      if (!duty) {
        throw new Error('duty_not_found');
      }

      const [assignment] = await tx
        .select({ userId: dutyAssignments.userId })
        .from(dutyAssignments)
        .where(and(
          eq(dutyAssignments.dutyId, dutyId),
          eq(dutyAssignments.userId, session.userId),
        ))
        .limit(1);

      if (!assignment) {
        throw new Error('not_assigned');
      }

      // Notify every school_admin in this school. For schools with
      // many admins this could become noisy — v2 should batch into
      // a daily roll-up instead of one notification per completion.
      const admins = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(
          eq(users.schoolId, session.schoolId),
          eq(users.role, 'school_admin'),
          eq(users.isActive, true),
        ))
        .limit(20);

      if (admins.length === 0) {
        // Solo school — just log + skip notification.
        logger.info(
          { dutyId, userId: session.userId, schoolId: session.schoolId },
          'duty.complete: solo school, no admins to notify',
        );
        return;
      }

      const completedAt = new Date();
      const timeLabel = duty.startTime
        ? formatTime12h(duty.startTime)
        : 'today';

      await tx.insert(notifications).values(
        admins.map((a) => ({
          schoolId: session.schoolId,
          userId: a.id,
          kind: 'system.message' as const,
          title: `${session.name} marked ${duty.location} complete`,
          body: `Duty at ${timeLabel} marked done at ${formatTime12h(completedAt.toTimeString().slice(0, 5))}.`,
          readAt: null,
          createdAt: completedAt,
        })),
      );
    });

    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'duty_not_found' || msg === 'not_assigned') {
      return Response.json({ error: msg }, { status: 400 });
    }
    logger.error({ err, dutyId }, 'duty.complete: failed');
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}