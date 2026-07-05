// apps/web/app/routes/api.admin.calendar.import.ts —
// Admin-only POST endpoint that accepts a calendar PDF, stages it,
// parses it via pdf_calendar_extract, caches the result under the
// returned jobId, and returns the parsed days for review.
//
// Mirrors apps/web/app/routes/api.onboarding.upload-pdf.ts but:
//   - Requires school_admin role (not just session).
//   - Caps parse output (no rows back if PDF has > 400 days).
//   - Caches parse under `cal:{jobId}` for the review page.
//   - Doesn't auto-commit; admin reviews + commits separately.

import type { Route } from './+types/api.admin.calendar.import';
import { requireRole, getSession } from '../../server/auth.server';
import { validateCsrfFromJson } from '../../server/csrf.server';
import { check } from '../../server/rate-limit.server';
import {
  stagePdfUpload,
  MAX_PDF_BYTES,
} from '../../server/uploads.server';
import { parseCalendarPdf } from '../../server/pdf_calendar_extract.server';
import { recordAuditFromRequest } from '../../server/audit.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

const MAX_PARSED_DAYS = 400;

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }
  const maybeSession = await getSession(request);
  if (!maybeSession) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const session = requireRole(maybeSession, ['school_admin']);
  const csrf = validateCsrfFromJson(request, {});
  if (!csrf.ok) return csrf.response;

  const rl = check({
    key: `calendar_import:user:${session.userId}`,
    max: 10,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfterSec ?? 60) },
      },
    );
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return Response.json(
      {
        error: 'unsupported_media_type',
        message: 'Expected multipart/form-data.',
      },
      { status: 415 },
    );
  }
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return Response.json(
      { error: 'invalid_request', message: 'Missing file field.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_PDF_BYTES) {
    return Response.json(
      { error: 'too_large', message: `Max ${MAX_PDF_BYTES} bytes.` },
      { status: 413 },
    );
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const staged = await stagePdfUpload({
    bytes: buf,
    schoolId: session.schoolId,
    userId: session.userId,
  });
  if (!staged.ok) {
    const status = staged.code === 'too_large' ? 413 : 400;
    return Response.json(
      { error: staged.code, message: staged.message },
      { status },
    );
  }

  const outcome = await parseCalendarPdf({
    filePath: staged.filePath,
    sha256: staged.sha256,
  });
  if (!outcome.ok) {
    await recordAuditFromRequest(request, {
      action: 'calendar_import.parse_failed',
      schoolId: session.schoolId,
      userId: session.userId,
      metadata: {
        code: outcome.code,
        message: outcome.message,
        sha256: outcome.sha256,
      },
    });
    return Response.json(
      { error: outcome.code, message: outcome.message, jobId: outcome.jobId },
      { status: outcome.code === 'scanned_pdf' ? 415 : 422 },
    );
  }

  if (outcome.days.length > MAX_PARSED_DAYS) {
    return Response.json(
      {
        error: 'too_many_days',
        message: `Parsed ${outcome.days.length} days; max ${MAX_PARSED_DAYS}.`,
        jobId: outcome.jobId,
      },
      { status: 422 },
    );
  }

  await recordAuditFromRequest(request, {
    action: 'calendar_import.parsed',
    schoolId: session.schoolId,
    userId: session.userId,
    metadata: {
      jobId: outcome.jobId,
      days: outcome.days.length,
      summary: outcome.summary,
      durationMs: outcome.durationMs,
      sha256: outcome.sha256,
    },
  });

  logger.info(
    {
      schoolId: session.schoolId,
      userId: session.userId,
      jobId: outcome.jobId,
      days: outcome.days.length,
      durationMs: outcome.durationMs,
    },
    'calendar import: parsed',
  );

  return Response.json({
    jobId: outcome.jobId,
    sha256: outcome.sha256,
    calendarTitle: outcome.calendarTitle,
    schoolYear: outcome.schoolYear,
    days: outcome.days,
    summary: outcome.summary,
    durationMs: outcome.durationMs,
  });
}