// apps/web/app/routes/app.api.reminders.delete.ts
//
// POST /app/api/reminders/delete — remove a reminder.

import { redirect } from 'react-router';
import type { Route } from './+types/app.api.reminders.delete';
import { validateCsrf } from '../../server/csrf.server';
import { getSession } from '../../server/auth.server';
import { deleteReminder } from '../../server/reminders.server';
import { recordAudit } from '../../server/audit.server';

export async function loader() {
  return redirect('/app/today');
}

export async function action({ request }: Route.ActionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const form = await request.formData();
  const reminderId = String(form.get('reminderId') ?? '').trim();
  if (!reminderId) return Response.json({ error: 'invalid_input' }, { status: 400 });

  const result = await deleteReminder(session.schoolId, reminderId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  recordAudit({
    schoolId: session.schoolId,
    actorUserId: session.userId,
    action: 'reminder.deleted',
    targetType: 'reminder',
    targetId: reminderId,
  }).catch(() => {});

  return Response.json({ ok: true });
}