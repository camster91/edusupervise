// apps/web/app/routes/api.coverage.absences.ts — Create an absence event.
//
// Admin-only. Validates the request, records the absence, and runs
// the Coverage Router orchestrator to find replacement teachers for
// each of the absent teacher's duties on that date.

import { z } from 'zod';
import type { Route } from './+types/api.coverage.absences';
import { requireRole } from '../../server/auth.server';
import { validateCsrf } from '../../server/csrf.server';
import {
  recordAbsence,
  routeAbsence,
} from '../../server/coverage.server';

const Body = z.object({
  teacherId: z.string().uuid(),
  absenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(500).optional(),
  source: z.enum(['direct', 'frontline', 'red_rover', 'swing', 'manual']).optional(),
  externalId: z.string().max(200).optional(),
  autoRoute: z.boolean().optional().default(true),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;
  const session = await requireRole(await (await import('../../server/auth.server')).getSession(request), 'school_admin');
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

  const { id, deduplicated } = await recordAbsence({
    schoolId: session.schoolId,
    teacherId: parsed.data.teacherId,
    absenceDate: parsed.data.absenceDate,
    reason: parsed.data.reason,
    source: parsed.data.source,
    externalId: parsed.data.externalId,
    createdBy: session.userId,
  });

  if (!parsed.data.autoRoute) {
    return Response.json({ id, deduplicated, assignments: [], uncovered: 0 });
  }

  const result = await routeAbsence({ absenceId: id });
  return Response.json({ id, deduplicated, ...result });
}

export async function loader() {
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}
