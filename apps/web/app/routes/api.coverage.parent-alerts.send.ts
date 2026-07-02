// apps/web/app/routes/api.coverage.parent-alerts.send.ts — Mock "send"
// a parent alert (Phase 3, v1).
//
// Authenticated. Flips the alert from 'draft' to 'sent'. v2: actually
// dispatch via Twilio (SMS) or Resend (email).

import { z } from 'zod';
import type { Route } from './+types/api.coverage.parent-alerts.send';
import { getSession, requireSession } from '../../server/auth.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { markAlertSent, listAlerts } from '../../server/parent-alerts.server';

const Body = z.object({ alertId: z.string().uuid() });

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const csrf = validateCsrfFromJson(request, body);
  if (!csrf.ok) return csrf.response;
  const session = requireSession(await getSession(request));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'validation_failed', issues: parsed.error.issues }, { status: 400 });
  }

  // Confirm the alert belongs to the current school (RLS would catch this
  // at the DB level, but we want a clean 404 rather than an empty result).
  const alerts = await listAlerts({ schoolId: session.schoolId, limit: 1000 });
  if (!alerts.find((a) => a.id === parsed.data.alertId)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  await markAlertSent(parsed.data.alertId, session.schoolId);
  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}
