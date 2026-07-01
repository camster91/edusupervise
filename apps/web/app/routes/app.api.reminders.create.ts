// apps/web/app/routes/app.api.reminders.create.ts
//
// POST /app/api/reminders/create — add a reminder to a duty.
//
// Body: { dutyId, minutesBefore, notifyEmail?, notifySms?, customMessage? }
//
// Resolves the dutyId → active assignment via reminders.server.ts and
// inserts a reminder row. The worker (apps/worker) picks it up on the
// next minute tick.

import { redirect } from 'react-router';
import type { Route } from './+types/app.api.reminders.create';
import { validateCsrf } from '../../server/csrf.server';
import { getSession } from '../../server/auth.server';
import {
  createReminder,
  findActiveAssignmentForDuty,
  listRemindersForDuty,
} from '../../server/reminders.server';
import { recordAudit } from '../../server/audit.server';

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
  const minutesBeforeRaw = String(form.get('minutesBefore') ?? '').trim();
  const notifyEmail = form.get('notifyEmail') === 'true' || form.get('notifyEmail') === 'on';
  const notifySms = form.get('notifySms') === 'true' || form.get('notifySms') === 'on';
  const customMessage = (form.get('customMessage') as string | null)?.trim() || null;

  const minutesBefore = Number(minutesBeforeRaw);
  if (!dutyId || !Number.isFinite(minutesBefore) || minutesBefore < 0) {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }

  const assignment = await findActiveAssignmentForDuty(session.schoolId, dutyId);
  if (!assignment) {
    return Response.json({ error: 'no_active_assignment' }, { status: 400 });
  }

  const result = await createReminder(session.schoolId, session.userId, {
    assignmentId: assignment.id,
    minutesBefore,
    notifyEmail,
    notifySms,
    customMessage,
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  // Best-effort audit — failures here don't block the response.
  recordAudit({
    schoolId: session.schoolId,
    actorUserId: session.userId,
    action: 'reminder.created',
    targetType: 'reminder',
    targetId: result.reminderId ?? null,
    metadata: { dutyId, minutesBefore, notifyEmail, notifySms },
  }).catch(() => {});

  // Return the updated list so the client can swap in the new row
  // without a full page reload (when invoked from the inline UI).
  const reminders = await listRemindersForDuty(dutyId, session.schoolId);
  return Response.json({ ok: true, reminders });
}