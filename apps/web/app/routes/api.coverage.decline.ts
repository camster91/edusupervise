// apps/web/app/routes/api.coverage.decline.ts — Decline a coverage request.
//
// Authenticated. The teacher must be the `new_teacher_id` on the
// assignment. Triggers a re-route of the parent absence event so a
// different replacement is found.

import { z } from 'zod';
import { json } from 'react-router';
import type { Route } from './+types/api.coverage.decline';
import { getSession, requireSession } from '../../server/auth.server';
import { declineCoverage } from '../../server/coverage.server';

const Body = z.object({
  assignmentId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, { status: 405 });
  }
  const session = requireSession(await getSession(request));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'validation_failed', issues: parsed.error.issues }, { status: 400 });
  }
  await declineCoverage({
    assignmentId: parsed.data.assignmentId,
    teacherId: session.userId,
    reason: parsed.data.reason,
  });
  return json({ ok: true });
}

export async function loader() {
  return json({ error: 'method_not_allowed' }, { status: 405 });
}
