/**
 * BullMQ processor for the `reminder.dispatch` job type.
 *
 * Spec section 2 / section 10:
 *   1. Worker picks up `reminder.dispatch` job at scheduled time.
 *   2. Worker validates job payload via Zod:
 *      `{ schoolId, reminderId, assignmentId, userId, channel, scheduledFor }`
 *      — missing `schoolId` is a hard error.
 *   3. Worker opens a transaction on its single system-role pool.
 *   4. Worker sets `SET LOCAL app.school_id = job.schoolId` defensively.
 *   5. Worker reads assignment, user contact info, school branding — all
 *      subject to RLS via the `app.school_id` setting, mirroring runtime
 *      behavior.
 *   6. Worker calls Resend (email) and/or Twilio (SMS).
 *   7. On success: writes `reminder_log` with status `sent`.
 *   8. On failure: BullMQ retries with exponential backoff (1m/5m/30m/2h/12h);
 *      after 5 attempts the worker's `failed` event handler writes the
 *      terminal state (see `retry-policy.ts`).
 *
 * Why the system role still sets `app.school_id`:
 *   - The system role BYPASSES RLS. That means it can also read the wrong
 *     school's data without a filter. Setting `app.school_id` defensively
 *     means an off-by-one bug in the payload (e.g. wrong reminderId) doesn't
 *     silently leak data across tenants.
 */

import { z } from 'zod';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '@edusupervise/db';
import {
  duties,
  dutyAssignments,
  reminders,
  reminderLog,
  schools,
  users,
} from '@edusupervise/db';
import { sendEmail } from '@edusupervise/email';
import { sendSms } from '@edusupervise/sms';
import {
  reminderJobSchema,
  INVALID_PAYLOAD_ERROR,
  type ReminderJobPayload,
} from '@edusupervise/schemas/reminder-job';
import type { Logger } from '../logger.js';

// Re-export so callers (retry-policy.ts, queue.server.ts, outbox-flush.ts,
// tests) can import the schema from a stable path. The schema itself
// lives in @edusupervise/schemas so producer + consumer share one source
// of truth.
export { reminderJobSchema, INVALID_PAYLOAD_ERROR };
export type { ReminderJobPayload };

// ---------------------------------------------------------------------------
// Processor factory
// ---------------------------------------------------------------------------

export interface ProcessorDeps {
  db: Db;
  logger: Logger;
  /** Override for tests — defaults to the env-driven `sendEmail` / `sendSms`. */
  sendEmail?: typeof sendEmail;
  sendSms?: typeof sendSms;
}

/**
 * Returns a BullMQ handler function that processes `reminder.dispatch`
 * jobs. We factor it as a factory so tests can swap the DB client +
 * transport without booting BullMQ.
 */
export function makeReminderProcessor(deps: ProcessorDeps) {
  const { db, logger } = deps;
  const doEmail = deps.sendEmail ?? sendEmail;
  const doSms = deps.sendSms ?? sendSms;

  return async function processReminder(job: Job): Promise<void> {
    const raw = job.data as unknown;

    // 1) Validate the payload. Invalid payloads must NOT touch the DB;
    //    per spec, the job is moved to BullMQ's failed set with
    //    `error: 'invalid_payload'`.
    const parsed = reminderJobSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i: { path: (string | number)[]; message: string }) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      logger.warn(
        { jobId: job.id, issues, payload: raw },
        'reminder.dispatch: invalid payload',
      );
      // Attach a marker the worker's `failed` handler can read so it
      // doesn't trigger the terminal bookkeeping for a malformed
      // payload (that's already captured in the spec-mandated audit row).
      throw new InvalidPayloadError(issues);
    }
    const payload = parsed.data;

    // 2) Open a transaction and defensively SET LOCAL app.school_id.
    //    The system role has BYPASSRLS; we still set the GUC so the
    //    behavior is identical to the runtime path. If a future bug
    //    drops us out of the system role, RLS would still kick in.
    const logRowId = randomUUID();

    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.school_id', ${payload.schoolId}, true)`,
        );

        // 3) Read assignment, user, school. All RLS-protected; with
        //    the school context set, they should return one row each.
        const assignmentRows = await tx
          .select()
          .from(dutyAssignments)
          .where(
            and(
              eq(dutyAssignments.id, payload.assignmentId),
              eq(dutyAssignments.schoolId, payload.schoolId),
            ),
          )
          .limit(1);
        const assignment = assignmentRows[0];

        const userRows = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.id, payload.userId),
              eq(users.schoolId, payload.schoolId),
            ),
          )
          .limit(1);
        const user = userRows[0];

        const schoolRows = await tx
          .select()
          .from(schools)
          .where(eq(schools.id, payload.schoolId))
          .limit(1);
        const school = schoolRows[0];

        const dutyRows = assignment
          ? await tx
              .select()
              .from(duties)
              .where(eq(duties.id, assignment.dutyId))
              .limit(1)
          : [];
        const duty = dutyRows[0];

        const reminderRows = await tx
          .select()
          .from(reminders)
          .where(eq(reminders.id, payload.reminderId))
          .limit(1);
        const reminder = reminderRows[0];

        if (!assignment || !user || !school || !duty || !reminder) {
          // Not all rows exist — emit a domain-level error. BullMQ will
          // retry. If the rows truly never existed, the retries exhaust
          // and the worker writes the audit + notification rows; if they
          // were deleted in flight, the audit tells the operator why
          // the reminder went out as failed.
          throw new Error(
            `reminder.dispatch: missing rows for ${payload.reminderId} (assignment=${!!assignment} user=${!!user} school=${!!school} duty=${!!duty} reminder=${!!reminder})`,
          );
        }

        // 4) Compose the message body. Real impls use react-email
        //    templates; for Tier 1 we ship a clear text body the
        //    caller can recognize in their inbox.
        const body = reminder.customMessage
          ? reminder.customMessage
          : `Reminder: your "${duty.description ?? duty.location}" duty starts at ${duty.startTime}.`;
        const subject = `Duty reminder — ${duty.location} at ${duty.startTime}`;

        let providerId: string | undefined;

        if (payload.channel === 'email') {
          if (!user.email) {
            throw new Error(
              `reminder.dispatch: user ${user.id} has no email address`,
            );
          }
          const result = await doEmail({
            to: user.email,
            subject,
            body,
          });
          providerId = result.providerId;
        } else {
          if (!user.phone) {
            throw new Error(
              `reminder.dispatch: user ${user.id} has no phone number`,
            );
          }
          const result = await doSms({
            to: user.phone,
            body,
          });
          providerId = result.providerId;
        }

        // 5) Write reminder_log row. UNIQUE(reminder_id, scheduled_for,
        //    channel) makes this idempotent across concurrent workers.
        //    Drizzle's onConflictDoNothing covers the rare case where
        //    a parallel worker beat us to the row.
        const inserted = await tx
          .insert(reminderLog)
          .values({
            id: logRowId,
            schoolId: payload.schoolId,
            reminderId: payload.reminderId,
            assignmentId: payload.assignmentId,
            userId: payload.userId,
            scheduledFor: new Date(payload.scheduledFor),
            channel: payload.channel,
            status: 'sent',
            sentAt: new Date(),
            error: null,
            attempts: job.attemptsMade + 1,
          })
          .onConflictDoUpdate({
            target: [
              reminderLog.reminderId,
              reminderLog.scheduledFor,
              reminderLog.channel,
            ],
            set: {
              status: 'sent',
              sentAt: new Date(),
              error: null,
              attempts: job.attemptsMade + 1,
            },
          })
          .returning();

        logger.info(
          {
            jobId: job.id,
            schoolId: payload.schoolId,
            reminderId: payload.reminderId,
            channel: payload.channel,
            providerId,
            attempts: job.attemptsMade + 1,
            logId: inserted[0]?.id ?? logRowId,
          },
          'reminder dispatched',
        );
      });
    } catch (err) {
      // For invalid_payload we don't retry — BullMQ's `failed` event
      // handler skips bookkeeping because the throw is typed.
      if (err instanceof InvalidPayloadError) {
        throw err;
      }
      // Everything else: increment attempts by throwing — BullMQ picks
      // up the throw and either schedules a retry or moves the job to
      // `failed` if TOTAL_ATTEMPTS is exhausted.
      logger.warn(
        {
          jobId: job.id,
          schoolId: payload.schoolId,
          reminderId: payload.reminderId,
          channel: payload.channel,
          attemptsMade: job.attemptsMade + 1,
          err,
        },
        'reminder.dispatch attempt failed',
      );
      throw err;
    }
  };
}

/**
 * Sentinel error type the processor throws for invalid payloads. The
 * worker's `failed` event listener checks `instanceof` to decide whether
 * to write the terminal bookkeeping (no — invalid payloads are caught
 * upstream by the spec-mandated audit row, and writing again would
 * double-count).
 */
export class InvalidPayloadError extends Error {
  override readonly name = 'InvalidPayloadError';
  constructor(message: string) {
    super(message);
  }
}

/** Convenience: assert a value parses as a valid job payload. */
export function parseReminderJob(value: unknown): ReminderJobPayload {
  const r = reminderJobSchema.safeParse(value);
  if (!r.success) {
    throw new InvalidPayloadError(
      r.error.issues
        .map((i: { path: (string | number)[]; message: string }) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    );
  }
  return r.data;
}
