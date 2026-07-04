// apps/web/app/routes/app.api.reminders.delete.ts
//
// POST /app/api/reminders/delete — remove a reminder.

import { redirect } from 'react-router';
import type { Route } from './+types/app.api.reminders.delete';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { getSession } from '../../server/auth.server';
import { deleteReminder } from '../../server/reminders.server';
import { recordAudit } from '../../server/audit.server';

export async function loader() {
  return redirect('/app/today');
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const formObj: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) formObj[k] = v;
  formObj.csrf = typeof formObj.csrf === 'string' ? formObj.csrf : '';
  const csrf = validateCsrfFromJson(request, formObj);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const reminderId = String(formObj['reminderId'] ?? '').trim();
  if (!reminderId) return Response.json({ error: 'invalid_input' }, { status: 400 });

  const result = await deleteReminder(session.schoolId, reminderId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  recordAudit({
    schoolId: session.schoolId,
    userId: session.userId,
    action: 'reminder.deleted',
    targetType: 'reminder',
    targetId: reminderId,
  }).catch(() => {});

  return Response.json({ ok: true });
}