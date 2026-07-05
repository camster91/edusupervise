// apps/web/app/routes/api.admin.calendar.commit.ts —
// Admin-only POST endpoint that commits a previously-parsed calendar
// to the cycle_calendar table. The import endpoint returns a jobId;
// the admin reviews the parsed days in the UI, then POSTs to this
// endpoint with the jobId + an explicit "yes, commit all" confirmation.
//
// Why two endpoints (parse + commit) instead of one:
//   - Auto-committing an admin upload risks bad data going live
//     before the admin sees it. Review-then-commit mirrors the
//     onboarding.pdf-review flow.

import { z } from 'zod';
import type { Route } from './+types/api.admin.calendar.commit';
import { getSession, requireRole } from '../../server/auth.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { readCachedParse } from '../../server/pdf_calendar_extract.server';
import { upsertCalendarDays } from '../../server/calendar-import.server';
import { recordAuditFromRequest } from '../../server/audit.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

const Body = z.object({
  jobId: z.string().uuid(),
  confirm: z.literal(true),
});

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
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
  if (!maybeSession) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const session = requireRole(maybeSession, ['school_admin']);

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'validation_failed',
        issues: parsed.error.issues,
        message: 'Body must include { jobId, confirm: true }.',
      },
      { status: 400 },
    );
  }

  const cached = await readCachedParse(parsed.data.jobId);
  if (!cached) {
    return Response.json(
      {
        error: 'job_expired',
        message:
          'Parse job expired or never existed. Re-upload the PDF to retry.',
      },
      { status: 404 },
    );
  }

  const result = await upsertCalendarDays({
    schoolId: session.schoolId,
    days: cached.days,
    importedBy: session.userId,
    jobId: cached.jobId,
  });

  await recordAuditFromRequest(request, {
    action: 'calendar_import.committed',
    schoolId: session.schoolId,
    userId: session.userId,
    metadata: {
      jobId: cached.jobId,
      result,
      sha256: cached.sha256,
    },
  });

  logger.info(
    {
      schoolId: session.schoolId,
      userId: session.userId,
      jobId: cached.jobId,
      result,
    },
    'calendar import: committed',
  );

  return Response.json({
    jobId: cached.jobId,
    result,
    calendarTitle: cached.calendarTitle,
    schoolYear: cached.schoolYear,
  });
}