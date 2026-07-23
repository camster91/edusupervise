/**
 * apps/worker/src/jobs/reminder-scheduler.ts
 *
 * Periodic scan of the `reminders` table that writes outbox rows for
 * any reminder whose fire-time is within the next scheduling window.
 *
 * Why this module exists:
 *   The reminder processor (apps/worker/src/jobs/reminders.ts) consumes
 *   BullMQ jobs and dispatches them via email/SMS. BullMQ jobs are
 *   enqueued by the outbox-flush loop from rows in the `outbox` table.
 *   The web app writes to `outbox` directly for transactional events
 *   (signup, billing). But REMINDERS are time-driven, not event-driven:
 *   "fire 15 minutes before Ms. Chen's cafeteria duty on the next Day 2
 *   of the cycle." Nothing in the web path knows when that is.
 *
 *   So this loop is the bridge between configuration (reminders table)
 *   and dispatch (outbox → BullMQ → processor). It runs every minute
 *   and asks: "for each enabled reminder, when is its next duty, and
 *   is that fire-time in the next 60 seconds?" If yes, INSERT INTO
 *   outbox. The outbox-flush loop picks it up and enqueues to BullMQ.
 *
 * Idempotency:
 *   The processor writes a row to `reminder_log` with a UNIQUE
 *   constraint on (reminder_id, scheduled_for, channel). If two
 *   scheduler ticks race and both write the same outbox row, the
 *   second processor run hits the unique violation and treats it as
 *   "already sent" (idempotent success). The scheduler itself can
 *   safely run as often as you like.
 *
 * Cross-school safety:
 *   All reads are by school_id. The scheduler uses the system-role
 *   client (BYPASSRLS) and filters explicitly by school — never
 *   cross-pollinate tenants.
 */

import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import type { Db } from '@edusupervise/db';
import {
  duties,
  dutyAssignments,
  reminders,
  outbox,
  cycleCalendar,
  schools,
} from '@edusupervise/db';
import type { Logger } from '../logger.js';
import { localTimeToUtc } from '../timezone.js';

export interface SchedulerOpts {
  db: Db;
  logger: Logger;
  /** Cap on reminders per tick. Default 200 — covers schools with up
   *  to ~500 active reminders comfortably within a minute window. */
  batchSize?: number;
  /** Override the "now" reference for tests. */
  now?: Date;
}

/**
 * Run one scheduler tick.
 *
 * For each enabled reminder, find the next duty the assignment covers
 * (today + next 14 days, by cycle day), compute fire-time = duty_start
 * - minutes_before, and INSERT INTO outbox if fire-time falls within
 * `now + 60s`. Also handles the edge case where fire-time is in the
 * past by a few minutes (clock skew, late scheduler ticks) — still
 * fires if the duty itself hasn't passed yet, so teachers get the
 * notification even if the worker was briefly down.
 */
export async function runSchedulerTick(opts: SchedulerOpts): Promise<{
  scanned: number;
  scheduled: number;
  errors: number;
}> {
  const batchSize = opts.batchSize ?? 200;
  const now = opts.now ?? new Date();
  // Lookahead window: 1 minute in the future (BullMQ job runs
  // immediately on enqueue, so this is the precise window). Also
  // include reminders whose fire-time is up to 5 minutes in the past
  // (clock skew, missed ticks) provided the duty itself is still in
  // the future.
  const windowStart = new Date(now.getTime() - 5 * 60_000);
  const windowEnd = new Date(now.getTime() + 60_000);

  let scanned = 0;
  let scheduled = 0;
  let errors = 0;
  let afterId: string | null = null;

  while (true) {
    const active = await opts.db
      .select({
        id: reminders.id,
        schoolId: reminders.schoolId,
        assignmentId: reminders.assignmentId,
        minutesBefore: reminders.minutesBefore,
        notifyEmail: reminders.notifyEmail,
        notifySms: reminders.notifySms,
      })
      .from(reminders)
      .where(and(
        eq(reminders.isEnabled, true),
        afterId ? gt(reminders.id, afterId) : undefined,
      ))
      .orderBy(asc(reminders.id))
      .limit(batchSize);

    if (active.length === 0) break;
    scanned += active.length;

    for (const r of active) {
      try {
        // Resolve the assignment → duty → next duty datetime.
      const [assignment] = await opts.db
        .select({
          id: dutyAssignments.id,
          userId: dutyAssignments.userId,
          dutyId: dutyAssignments.dutyId,
          startDate: dutyAssignments.startDate,
        })
        .from(dutyAssignments)
        .where(and(
          eq(dutyAssignments.id, r.assignmentId),
          eq(dutyAssignments.schoolId, r.schoolId),
        ))
        .limit(1);
      if (!assignment) continue;

      const [duty] = await opts.db
        .select({
          id: duties.id,
          cycleDay: duties.cycleDay,
          startTime: duties.startTime,
        })
        .from(duties)
        .where(and(
          eq(duties.id, assignment.dutyId),
          eq(duties.schoolId, r.schoolId),
          eq(duties.isActive, true),
        ))
        .limit(1);
      if (!duty || !duty.startTime) continue;

      const [school] = await opts.db
        .select({ timezone: schools.timezone })
        .from(schools)
        .where(eq(schools.id, r.schoolId))
        .limit(1);
      if (!school) continue;

      // Find the next cycle_day=X date on or after `now`, scanning up
      // to 14 days forward. cycleCalendar is the source of truth for
      // "what cycle day is this date" — we look it up.
      // Strategy: read cycle_calendar rows in [now, now+14d], find
      // the first one whose cycle_day === duty.cycleDay. Then
      // combine that date with duty.startTime to get the next duty
      // timestamp.
      const startDate = assignment.startDate as unknown as Date | null;
      const candidateDates = await opts.db
        .select({
          date: cycleCalendar.date,
          cycleDay: cycleCalendar.cycleDay,
          // Migration 0013: skip reminders on non-instructional days
          // (PD days, holidays, board breaks). Duty assignments still
          // exist on those dates — they just shouldn't fire reminders.
          isInstructional: cycleCalendar.isInstructional,
        })
        .from(cycleCalendar)
        .where(and(
          eq(cycleCalendar.schoolId, r.schoolId),
          gte(cycleCalendar.date, dateOnlyInTimeZone(now, school.timezone)),
        ))
        .orderBy(cycleCalendar.date)
        .limit(60);

      let nextDutyAt: Date | null = null;
      for (const c of candidateDates) {
        if (c.cycleDay !== duty.cycleDay) continue;
        // Migration 0013: skip on non-instructional days.
        if (c.isInstructional === false) continue;
        // Combine the school's local calendar date + local duty start,
        // then convert that wall-clock to an absolute UTC instant. The
        // conversion derives the offset for this exact date, so seasonal
        // DST changes are handled rather than applying today's offset.
        const dutyAt = localTimeToUtc(parseDateOnly(c.date), duty.startTime as string, school.timezone);
        // Honor the assignment start_date — don't schedule before the
        // assignment actually began.
        if (startDate && dutyAt < new Date(startDate)) continue;
        if (dutyAt < now) continue; // already happened
        nextDutyAt = dutyAt;
        break;
      }
      if (!nextDutyAt) continue;

      const fireAt = new Date(nextDutyAt.getTime() - r.minutesBefore * 60_000);
      if (fireAt < windowStart || fireAt > windowEnd) continue; // not in this tick's window

      // One outbox row per channel (email + sms + push-expo). The
      // reminder_log dedup unique constraint catches double-fires
      // (UNIQUE(reminder_id, scheduled_for, channel)).
      //
      // 'push-expo' is added unconditionally — if the user has no
      // active mobile_push_subscriptions, the dispatcher's
      // sendMobilePushToUser returns 0 subscriptions and the job
      // completes as a successful no-op (mobile push is best-effort).
      // We don't gate on notifyEmail / notifySms flags because Expo
      // push is opt-in via app install, not via the reminder config.
      const channels: Array<'email' | 'sms' | 'push-expo'> = [];
      if (r.notifyEmail) channels.push('email');
      if (r.notifySms) channels.push('sms');
      channels.push('push-expo');

      for (const channel of channels) {
        const payload = {
          schoolId: r.schoolId,
          reminderId: r.id,
          assignmentId: r.assignmentId,
          userId: assignment.userId,
          channel,
          scheduledFor: fireAt.toISOString(),
          dutyStartAt: nextDutyAt.toISOString(),
        };
        const inserted = await opts.db.transaction(async (tx) => {
          const dedupKey = `${r.id}:${fireAt.toISOString()}:${channel}`;
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(hashtextextended(${dedupKey}, 0))
          `);
          return tx.execute(sql`
            INSERT INTO outbox (school_id, job_type, payload, enqueued_at)
            SELECT ${r.schoolId}, 'reminder.dispatch', ${JSON.stringify(payload)}::jsonb, NULL
            WHERE NOT EXISTS (
              SELECT 1
              FROM outbox existing
              WHERE existing.school_id = ${r.schoolId}
                AND existing.job_type = 'reminder.dispatch'
                AND existing.payload->>'reminderId' = ${r.id}
                AND existing.payload->>'scheduledFor' = ${fireAt.toISOString()}
                AND existing.payload->>'channel' = ${channel}
            )
            RETURNING id
          `);
        });
        if (inserted.length > 0) scheduled++;
      }

      opts.logger.info(
        {
          reminderId: r.id,
          schoolId: r.schoolId,
          dutyAt: nextDutyAt.toISOString(),
          fireAt: fireAt.toISOString(),
          channels,
        },
        'reminder scheduler: enqueued',
      );
      } catch (err) {
        errors++;
        opts.logger.error({ err, reminderId: r.id }, 'reminder scheduler: tick error');
      }
    }

    afterId = active[active.length - 1]!.id;
    if (active.length < batchSize) break;
  }

  return { scanned, scheduled, errors };
}

export interface SchedulerLoopHandle {
  stop(): Promise<void>;
}

/**
 * Long-running scheduler loop. Calls runSchedulerTick every
 * `intervalMs` (default 60_000 = 1 min). The interval is aligned to
 * wall-clock minute boundaries so all workers fire near each other
 * (avoiding the thundering-herd from each worker running on its own
 * tick).
 */
export function startReminderSchedulerLoop(opts: SchedulerOpts & { intervalMs?: number }): SchedulerLoopHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick() {
    if (stopped) return;
    try {
      const result = await runSchedulerTick(opts);
      if (result.scheduled > 0) {
        opts.logger.info(result, 'reminder scheduler tick complete');
      } else {
        opts.logger.debug(result, 'reminder scheduler tick complete');
      }
    } catch (err) {
      opts.logger.error({ err }, 'reminder scheduler tick failed');
    }
    if (!stopped) {
      // Align to the next minute boundary + interval for steady cadence.
      const now = Date.now();
      const drift = now % intervalMs;
      const delay = intervalMs - drift;
      timer = setTimeout(tick, delay);
    }
  }

  // Kick off after a 5s startup delay (gives the rest of the worker
  // time to come up cleanly).
  timer = setTimeout(tick, 5_000);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function dateOnlyInTimeZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid calendar date: ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}