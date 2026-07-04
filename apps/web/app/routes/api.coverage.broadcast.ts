// apps/web/app/routes/api.coverage.broadcast.ts — Broadcast a coverage
// request to all eligible teachers (Phase 3 §3.4).
//
// Admin-only. Validates the request, records the absence with
// `source='broadcast'`, then runs `routeAbsence` which fans out to
// all eligible teachers. First to accept wins; remaining rows are
// auto-cancelled via the existing acceptCoverage flow.

import { z } from 'zod';
import type { Route } from './+types/api.coverage.broadcast';
import { getSession, requireRole } from '../../server/auth.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { broadcastCoverageRequest } from '../../server/coverage.server';
import { requireSchoolPlan } from '../../server/plan-enforcement.server';
import { withSchoolId } from '../../server/db.server';
import { recordAudit, AUDIT } from '../../server/audit.server';

const Body = z.object({
  teacherId: z.string().uuid(),
  absenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(500).optional(),
  externalId: z.string().max(200).optional(),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const csrf = validateCsrfFromJson(request, body as Record<string, unknown>);
  if (!csrf.ok) return csrf.response;

  const maybeSession = await getSession(request);
  if (!maybeSession) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const session = requireRole(maybeSession, ['school_admin']);

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Phase 3 §3.3 — broadcast is a paid feature (school tier).
  const gate = await withSchoolId(session.schoolId, async (tx) =>
    requireSchoolPlan(tx, session.schoolId, 'coverage.broadcast'),
  );
  if (!gate.ok) return gate.response;

  const result = await broadcastCoverageRequest({
    schoolId: session.schoolId,
    teacherId: parsed.data.teacherId,
    absenceDate: parsed.data.absenceDate,
    reason: parsed.data.reason,
    externalId:
      parsed.data.externalId ?? `broadcast:${parsed.data.teacherId}:${parsed.data.absenceDate}`,
    createdBy: session.userId,
  });

  await recordAudit({
    schoolId: session.schoolId,
    userId: session.userId,
    action: AUDIT.COVERAGE_BROADCAST,
    targetType: 'coverage_event',
    targetId: result.absenceId,
    metadata: {
      teacherId: parsed.data.teacherId,
      absenceDate: parsed.data.absenceDate,
      eligibleCount: result.eligibleCount,
    },
  });

  return Response.json(result);
}

export async function loader() {
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}
