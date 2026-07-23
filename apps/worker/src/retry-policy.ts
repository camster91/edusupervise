/**
 * BullMQ retry policy for reminder dispatch jobs.
 *
 * Spec section 10: "on send failure, BullMQ retries with exponential
 * backoff: 1m, 5m, 30m, 2h, 12h. After 5 failed attempts, mark
 * `reminder_log.status = 'failed'`, write `audit_log` with
 * `action = 'reminder.failed'`, and insert a `notifications` row."
 *
 * BullMQ's `attempts` field counts the JOB SLOT — the job runs at most
 * `attempts` times total. We set `attempts: 5`, meaning 1 initial + 4
 * retries. The custom backoff strategy hands us `attemptsMade` (the count
 * BEFORE the next attempt); we map that to the next delay in the schedule.
 *
 * The five-step schedule below corresponds to:
 *   - attempt 1 fails → wait 1 minute
 *   - attempt 2 fails → wait 5 minutes
 *   - attempt 3 fails → wait 30 minutes
 *   - attempt 4 fails → wait 2 hours
 *   - attempt 5 fails → BullMQ moves the job to `failed`, our handler
 *                      writes the terminal reminder_log.status='failed',
 *                      audit_log, and notification row.
 *
 * The terminal-failure handler lives alongside this module so the policy
 * + final-failure bookkeeping stay co-located. The worker wires it via
 * `worker.on('failed', handler)`.
 */

import type { JobsOptions } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@edusupervise/db';
import {
  auditLog,
  notifications,
  reminderLog,
  sql,
} from '@edusupervise/db';
import type { Logger } from './logger.js';
import type { ReminderJobPayload } from './jobs/reminders.js';

/**
 * Internal BullMQ type for the backoff strategy callback signature.
 * Not directly imported to keep `bullmq/types/*` paths out of our
 * exports (those paths change between minor versions).
 */
type BackoffStrategy = (
  attemptsMade: number,
  type?: string,
  err?: Error,
  // 4th argument is the MinimalJob but we don't use it. The signature
  // is permissive to match BullMQ's contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  job?: any,
) => number;

/**
 * Spec retry schedule. The Nth element is the delay BEFORE the (N+1)th
 * attempt. Indexes 0-3 are the between-attempts delays; index 4 would be
 * the delay before a hypothetical 6th attempt but BullMQ never asks for
 * it (attempts=5 caps out).
 */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 60 * 60_000, // 2 hours
  12 * 60 * 60_000, // 12 hours
];

export const TOTAL_ATTEMPTS = 5;

/**
 * BullMQ calls this on each failed attempt to decide how long to wait
 * before retrying. `attemptsMade` is the number of attempts already made
 * (so 0 means the first attempt just failed).
 *
 * We map attemptsMade → delay[attemptsMade] for the first 4 retries; the
 * 5th attempt never asks for a delay because TOTAL_ATTEMPTS=5 caps out.
 */
export function reminderBackoff(
  attemptsMade: number,
  _type?: string,
  _err?: Error,
  // 4th argument is the MinimalJob but we don't use it. The signature
  // is permissive to match BullMQ's contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _job?: any,
): number {
  const next = RETRY_DELAYS_MS[attemptsMade];
  if (next === undefined) {
    // Past the schedule — return the last delay so BullMQ won't
    // immediately retry. Doesn't matter much in practice because
    // TOTAL_ATTEMPTS caps execution.
    return RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  }
  return next;
}

export const REMINDER_JOB_OPTIONS: JobsOptions = {
  attempts: TOTAL_ATTEMPTS,
  backoff: {
    type: 'custom',
  },
  // Remove completed jobs after a day so we don't bloat Redis. Failed
  // jobs get their own retention (7 days) — operators want to peek at
  // the failure history without it sliding off the cliff.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

/**
 * Default queue + job names. Keep them as constants so the worker, the
 * server-side producer (`apps/web/server/queue.server.ts`), and the
 * outbox flusher all agree on the same string.
 */
export const QUEUE_NAME = 'reminders';
export const JOB_NAME_DISPATCH = 'reminder.dispatch';

/**
 * Handle the terminal failure: write `reminder_log.status='failed'`,
 * an `audit_log` row (system action `reminder.failed`), and a
 * `notifications` row so the assigned teacher sees a bell badge and the
 * admin sees the row in the audit log.
 *
 * Idempotency: the `reminder_log` UNIQUE(reminder_id, scheduled_for,
 * channel) constraint means a concurrent dispatch for the same
 * (reminder, slot, channel) is the loser's problem. We use
 * ON CONFLICT DO UPDATE so the final-state row is the failed one if a
 * `pending`/`sent` row was somehow created by a parallel worker.
 */
export interface FinalFailureOpts {
  db: Db;
  logger: Logger;
  payload: ReminderJobPayload;
  error: Error;
}

export async function onFinalFailure(opts: FinalFailureOpts): Promise<void> {
  const { db, logger, payload, error } = opts;
  const errMsg = (error?.message ?? String(error)).slice(0, 1000);

  try {
    let recordedFailure = false;
    await db.transaction(async (tx) => {
      // Defensive `SET LOCAL` so behavior matches the runtime path even
      // though the system role bypasses RLS for these writes.
      await tx.execute(
        sql`SELECT set_config('app.school_id', ${payload.schoolId}, true)`,
      );

      // 1) reminder_log: insert failed when absent, or transition only
      //    a still-pending row. A sent row is immutable.
      const changed = await tx
        .insert(reminderLog)
        .values({
          schoolId: payload.schoolId,
          reminderId: payload.reminderId,
          assignmentId: payload.assignmentId,
          userId: payload.userId,
          scheduledFor: new Date(payload.scheduledFor),
          channel: payload.channel,
          status: 'failed',
          error: errMsg,
          attempts: TOTAL_ATTEMPTS,
          sentAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: reminderLog.id });

      const transitioned = changed.length > 0
        ? changed
        : await tx
            .update(reminderLog)
            .set({
              status: 'failed',
              error: errMsg,
              attempts: TOTAL_ATTEMPTS,
            })
            .where(and(
              eq(reminderLog.reminderId, payload.reminderId),
              eq(reminderLog.scheduledFor, new Date(payload.scheduledFor)),
              eq(reminderLog.channel, payload.channel),
              eq(reminderLog.status, 'pending'),
            ))
            .returning({ id: reminderLog.id });

      // A late failed event racing with a completed send must be a no-op,
      // including its audit/notification side effects.
      if (transitioned.length === 0) return;
      recordedFailure = true;

      // 2) audit_log: system-initiated row. user_id stays NULL per spec
      //    ("NULL for system"); metadata captures the reminder
      //    identifiers and the channel that failed.
      await tx.insert(auditLog).values({
        schoolId: payload.schoolId,
        userId: null,
        action: 'reminder.failed',
        targetType: 'reminder_log',
        targetId: null,
        metadata: {
          reminderId: payload.reminderId,
          assignmentId: payload.assignmentId,
          userId: payload.userId,
          channel: payload.channel,
          scheduledFor: payload.scheduledFor,
          attempts: TOTAL_ATTEMPTS,
          error: errMsg,
        },
        ipAddress: null,
        userAgent: null,
      });

      // 3) notifications row: surfaces in the bell for the assigned
      //    teacher (and the admin sees the audit row).
      await tx.insert(notifications).values({
        schoolId: payload.schoolId,
        userId: payload.userId,
        kind: 'reminder.failed',
        title: 'Reminder failed to send',
        body: errMsg,
        linkUrl: '/app/reminders',
      });
    });

    if (recordedFailure) {
      logger.error(
        {
          reminderId: payload.reminderId,
          assignmentId: payload.assignmentId,
          userId: payload.userId,
          channel: payload.channel,
          err: error,
        },
        'reminder exhausted retries',
      );
    } else {
      logger.info(
        {
          reminderId: payload.reminderId,
          channel: payload.channel,
        },
        'terminal failure ignored because reminder was already terminal',
      );
    }
  } catch (err) {
    // Failure to write the audit/notification is itself an alarm-worthy
    // event. Log loudly; the next-heartbeat will still record liveness.
    logger.error(
      { err, payload, originalError: error },
      'onFinalFailure: terminal bookkeeping failed',
    );
  }
}

/**
 * Filter for BullMQ's `failed` event. BullMQ fires `failed` for every
 * failed attempt; we only want to run the terminal-failure handler when
 * the job actually ran out of attempts. Use `attemptsMade >= TOTAL_ATTEMPTS`
 * because `attemptsMade` is the count BEFORE BullMQ moves the job to the
 * failed set.
 */
export function isFinalFailure(
  job: { attemptsMade: number },
): boolean {
  return job.attemptsMade >= TOTAL_ATTEMPTS;
}
