// apps/web/app/routes/api.onboarding.solo.ts
//
// POST /api/onboarding/solo — Final submit of the solo teacher
// onboarding wizard. Creates one duty row, one dutyAssignment row,
// and one reminders row for the logged-in user. CSRF-protected.
// On success: 302 -> /app/today.
//
// Spec: docs/superpowers/specs/2026-07-04-phase-1-solo.md, section 1.2
// (step 4 = first duty, step 5 = reminder style).

import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';
import type { Route } from './+types/api.onboarding.solo';
import {
  duties,
  dutyAssignments,
  reminders,
} from '@edusupervise/db';
import { getSession } from '../../server/auth.server';
import { withSchoolId } from '../../server/db.server';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import { clientIp as readClientIp } from '../../server/client-ip.server';
import { logger } from '../../server/logger.server';
import { recordAudit } from '../../server/audit.server';

export async function loader() {
  // GET on this POST-only endpoint — redirect home so typing the URL
  // doesn't 405.
  return redirect('/onboarding/solo');
}



function clientUa(request: Request): string | null {
  return request.headers.get('user-agent') ?? null;
}

/**
 * Parse the user-supplied reminder style into the runtime minutesBefore
 * + channel booleans for the `reminders` row. Allowed styles match
 * the wizard's radio buttons. Unknown styles default to a 15-min email.
 */
function parseReminderStyle(
  raw: string | null,
): { minutesBefore: number; notifyEmail: boolean; notifySms: boolean; style: string } {
  switch (raw) {
    case '30m_email_sms':
      return { minutesBefore: 30, notifyEmail: true, notifySms: true, style: '30m_email_sms' };
    case 'custom':
      return { minutesBefore: 15, notifyEmail: true, notifySms: false, style: 'custom' };
    case '15m_email':
    default:
      return { minutesBefore: 15, notifyEmail: true, notifySms: false, style: '15m_email' };
  }
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  const session = await getSession(request);
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Only solo roles reach this endpoint. school_admin and substitute
  // short-circuit at the wizard's loader — fail closed if the gate is
  // ever bypassed.
  // Defensive role gate. /onboarding/solo's loader already redirects
  // school_admin to /onboarding/admin and substitute to /app/today, so
  // reaching this endpoint implies teacher or educational_assistant. We
  // use a string-set check because auth.server.ts's UserRole type
  // (currently 'school_admin' | 'teacher' | 'substitute') doesn't list
  // 'educational_assistant' yet — that's a pre-Phase-1 gap, not ours to
  // fix in this commit. The runtime check still fails closed for any
  // role outside the wizard's intent.
  // The two roles accepted here are 'teacher' and 'educational_assistant'.
  // We invert the check (block anything not in the allowed set) so TS
  // doesn't narrow session.role into a literal that overlaps 'educational_assistant'.
  const ALLOWED_SOLO = new Set(['teacher', 'educational_assistant']);
  if (!ALLOWED_SOLO.has(session.role)) {
    return Response.json(
      { error: 'wrong_role_for_solo_wizard' },
      { status: 403 },
    );
  }
  const soloRole = session.role as 'teacher' | 'educational_assistant';

  // ---------------------------------------------------------------------
  // Input validation. We intentionally do NOT validate district or
  // cycleLen — those are captured for product analytics only (audit
  // log row) and have no schema columns yet.
  // ---------------------------------------------------------------------
  const dutyName = String(form.get('dutyName') ?? '').trim();
  const location = String(form.get('location') ?? '').trim();
  const startTime = String(form.get('startTime') ?? '').trim();
  const endTime = String(form.get('endTime') ?? '').trim();
  const reminderStyle = String(form.get('reminderStyle') ?? '15m_email').trim();

  if (!dutyName || dutyName.length > 80) {
    return Response.json({ error: 'Duty name is required (1-80 chars).' }, { status: 400 });
  }
  if (!location || location.length > 80) {
    return Response.json({ error: 'Location is required (1-80 chars).' }, { status: 400 });
  }
  // HH:MM 24h. Postgres' TIME column accepts this directly.
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return Response.json({ error: 'Start and end times must be HH:MM.' }, { status: 400 });
  }
  if (endTime <= startTime) {
    return Response.json({ error: 'End time must be after start time.' }, { status: 400 });
  }

  const reminder = parseReminderStyle(reminderStyle);

  try {
    const result = await withSchoolId(session.schoolId, async (tx) => {
      // 1) Create the duty. Solo school's first duty goes on cycle day 1
      //    so the Today screen has something to render on day-1 rotation;
      //    later duties can adjust the cycle day through the standard
      //    /app/duties/new flow.
      const [duty] = await tx
        .insert(duties)
        .values({
          schoolId: session.schoolId,
          cycleDay: 1,
          startTime,
          endTime,
          location: `${dutyName} \u2014 ${location}`,
          description: null,
          requiresVest: false,
          requiresRadio: false,
          isActive: true,
          createdBy: session.userId,
        })
        .returning({ id: duties.id });
      if (!duty) throw new Error('duty_insert_failed');

      // 2) Assign the user to it. startDate = today (UTC truncated).
      const today = new Date().toISOString().slice(0, 10);
      const [assignment] = await tx
        .insert(dutyAssignments)
        .values({
          schoolId: session.schoolId,
          dutyId: duty.id,
          userId: session.userId,
          startDate: today,
          endDate: null,
          createdBy: session.userId,
        })
        .returning({ id: dutyAssignments.id });
      if (!assignment) throw new Error('assignment_insert_failed');

      // 3) Reminder row. minutes_before + channels come from the wizard's
      //    step-5 choice. The dispatcher cron will pick this up and
      //    schedule the first send at duty start_time - 15 minutes.
      await tx.insert(reminders).values({
        schoolId: session.schoolId,
        assignmentId: assignment.id,
        minutesBefore: reminder.minutesBefore,
        isEnabled: true,
        notifyEmail: reminder.notifyEmail,
        notifySms: reminder.notifySms,
        customMessage: null,
      });

      return { dutyId: duty.id, assignmentId: assignment.id };
    });

    // Audit row. Captures district + cycleLen + reminderStyle for
    // product analytics (no schema columns yet). Non-fatal if it fails.
    const district = String(form.get('district') ?? '').trim();
    const cycleLen = String(form.get('cycleLen') ?? '5').trim();
    await recordAudit({
      schoolId: session.schoolId,
      userId: session.userId,
      // Hardcoded action string — Phase 3 will lift this into AUDIT.* constants.
      action: 'onboarding.solo_duty_created',
      targetType: 'duty',
      targetId: result.dutyId,
      metadata: {
        district,
        cycleLen,
        reminderStyle: reminder.style,
        dutyName,
        location,
        startTime,
        endTime,
        role: soloRole,
      },
      ipAddress: readClientIp(request),
      userAgent: clientUa(request),
    });

    logger.info(
      {
        userId: session.userId,
        schoolId: session.schoolId,
        dutyId: result.dutyId,
        reminderStyle: reminder.style,
      },
      'onboarding.solo: first duty created',
    );

    return redirect('/app/today');
  } catch (err) {
    logger.error({ err, userId: session.userId }, 'onboarding.solo: failed');
    return Response.json({ error: 'onboarding_failed' }, { status: 500 });
  }
}
