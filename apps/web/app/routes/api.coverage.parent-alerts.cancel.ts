// apps/web/app/routes/api.coverage.parent-alerts.cancel.ts — Cancel a
// parent alert (Phase 3).

import { z } from 'zod';
import type { Route } from './+types/api.coverage.parent-alerts.cancel';
import { getSession, requireSession } from '../../server/auth.server';
import { validateCsrf } from '../../server/csrf.server';
import { cancelAlert, listAlerts } from '../../server/parent-alerts.server';

const Body = z.object({ alertId: z.string().uuid() });

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;
  const session = requireSession(await getSession(request));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'validation_failed', issues: parsed.error.issues }, { status: 400 });
  }

  // Confirm the alert belongs to the current school.
  const alerts = await listAlerts({ schoolId: session.schoolId, limit: 1000 });
  if (!alerts.find((a) => a.id === parsed.data.alertId)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  await cancelAlert(parsed.data.alertId, session.schoolId);
  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}
