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
import { sendMobilePushToUser } from '@edusupervise/push';
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
  /** Override for tests — defaults to the real @edusupervise/push dispatcher. */
  sendMobilePush?: typeof sendMobilePushToUser;
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
  const doMobilePush = deps.sendMobilePush ?? sendMobilePushToUser;

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
    const attempt = job.attemptsMade + 1;

    // Commit the claim before calling any external provider. Attempts are
    // monotonic, so a BullMQ retry (attempt N+1) may reclaim a pending row,
    // while a concurrent duplicate at the same attempt cannot.
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.school_id', ${payload.schoolId}, true)`,
      );
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
          status: 'pending',
          sentAt: null,
          error: null,
          attempts: attempt,
        })
        .onConflictDoNothing()
        .returning({ id: reminderLog.id });
      if (inserted.length > 0) return true;

      const reclaimed = await tx
        .update(reminderLog)
        .set({ attempts: attempt, error: null })
        .where(and(
          eq(reminderLog.reminderId, payload.reminderId),
          eq(reminderLog.scheduledFor, new Date(payload.scheduledFor)),
          eq(reminderLog.channel, payload.channel),
          eq(reminderLog.status, 'pending'),
          sql`${reminderLog.attempts} < ${attempt}`,
        ))
        .returning({ id: reminderLog.id });
      return reclaimed.length > 0;
    });

    if (!claimed) {
      logger.info(
        {
          jobId: job.id,
          schoolId: payload.schoolId,
          reminderId: payload.reminderId,
          channel: payload.channel,
        },
        'reminder dispatch skipped: delivery slot already claimed',
      );
      return;
    }

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
        const pushTitle = `${duty.location} — duty in ${formatRelativeTime(payload.scheduledFor)}`;

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
        } else if (payload.channel === 'sms') {
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
        } else {
          // 'push-expo' — best-effort. The dispatcher is a thin wrapper
          // around the Expo HTTP API. It NEVER throws (see expo.ts
          // header comment). If the user has no active mobile
          // subscriptions, result.subscriptionsFound is 0 and providerId
          // stays undefined — we still mark the reminder_log row as
          // 'sent' because the user has email/SMS as fallbacks. This
          // matches the existing "missing recipient data is a soft
          // warning" philosophy.
          //
          // Security review E-007: the mobile app reads data.dutyId via
          // Notifications.addNotificationResponseReceivedListener and
          // validates it with a strict UUID v4 regex before any
          // router.push. We always send the assignmentId as dutyId so
          // the tap target is unambiguous.
          const pushResult = await doMobilePush(
            db,
            payload.userId,
            payload.schoolId,
            {
              title: pushTitle,
              body: body,
              kind: 'reminder',
              linkUrl: '/app/today',
              data: {
                dutyId: payload.assignmentId,
                reminderId: payload.reminderId,
                scheduledFor: payload.scheduledFor,
              },
            },
            // The push package's PushLogger interface is structurally
            // compatible with the worker's pino logger (warn/info/error);
            // the cast silences a type-only mismatch on `debug`.
            logger as unknown as Parameters<typeof sendMobilePushToUser>[4],
          );
          // Encode the dispatch result into providerId for observability.
          // Format: "expo:found=N,sent=N,revoked=N,failed=N"
          providerId = `expo:found=${pushResult.subscriptionsFound},sent=${pushResult.messagesSent},revoked=${pushResult.tokensRevoked},failed=${pushResult.messagesFailed}`;
        }

        // 5) Transition the row claimed above from pending to sent.
        // Guard status='pending' so a terminal state can never be
        // overwritten by a late duplicate completion.
        const inserted = await tx
          .update(reminderLog)
          .set({
            status: 'sent',
            sentAt: new Date(),
            error: null,
            attempts: job.attemptsMade + 1,
          })
          .where(and(
            eq(reminderLog.reminderId, payload.reminderId),
            eq(reminderLog.scheduledFor, new Date(payload.scheduledFor)),
            eq(reminderLog.channel, payload.channel),
            eq(reminderLog.status, 'pending'),
            eq(reminderLog.attempts, attempt),
          ))
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

/**
 * Format a fire-time as a short human-readable string for the push
 * notification title (e.g. "in 15m", "in 1h", "now"). Pure UTC math —
 * the worker's job is to fire at a wall-clock instant, not to localize
 * the title (the mobile app can localize it on receipt if needed).
 */
function formatRelativeTime(scheduledForIso: string): string {
  const target = new Date(scheduledForIso).getTime();
  if (!Number.isFinite(target)) return 'soon';
  const now = Date.now();
  const diffMs = target - now;
  if (Math.abs(diffMs) < 60_000) return 'now';
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}
