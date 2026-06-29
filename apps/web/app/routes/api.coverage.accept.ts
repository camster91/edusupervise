// apps/web/app/routes/api.coverage.accept.ts — Accept a coverage request.
//
// Authenticated. The teacher must be the `new_teacher_id` on the
// assignment. Idempotent.

import { z } from 'zod';
import type { Route } from './+types/api.coverage.accept';
import { getSession, requireSession } from '../../server/auth.server';
import { validateCsrf } from '../../server/csrf.server';
import { acceptCoverage } from '../../server/coverage.server';

const Body = z.object({ assignmentId: z.string().uuid() });

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
  await acceptCoverage({ assignmentId: parsed.data.assignmentId, teacherId: session.userId });
  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}
