/**
 * scripts/run-worker-tests.ts — Node-native worker integration test runner.
 *
 * Why this exists:
 *   Vitest's SSR loader mishandles pnpm-symlinked CJS modules. bullmq@5.79
 *   declares `main: dist/cjs/index.js` and that file does
 *   `require('./classes')` which resolves under Node to
 *   `dist/cjs/classes/index.js` — but Vite's resolve algorithm tries
 *   `dist/cjs/classes.{js,ts,...}` and never the directory form, so it
 *   raises `Cannot find module './classes'` (and the same trap applies
 *   to bullmq's ESM build's `import 'ioredis/built/utils'`).
 *
 *   Plain Node resolves both forms correctly. `tsx` loads the .ts source
 *   for the worker + provider packages. So this script boots tsx and
 *   runs the worker test through a tiny test harness — same shape as
 *   vitest's API for `describe`/`it`/`beforeAll`/etc, but no Vite.
 *
 *   Output matches what `pnpm test:integration` looks like so the
 *   dashboard CI signal is consistent.
 *
 * Usage:
 *   pnpm --filter @edusupervise/worker test:integration
 */

import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  auditLog,
  duties,
  dutyAssignments,
  getRuntimeClient,
  getSystemClient,
  notifications,
  reminders,
  reminderLog,
  schools,
  users,
  workerHeartbeats,
  withSchoolContext,
} from '@edusupervise/db';
import {
  InvalidPayloadError,
  makeReminderProcessor,
} from '@edusupervise/worker/jobs/reminders';
import {
  isFinalFailure,
  onFinalFailure,
} from '@edusupervise/worker/retry-policy';
import { writeHeartbeat } from '@edusupervise/worker/heartbeat';
import { pinoLike } from '@edusupervise/worker/logger';
import {
  dispatchAtUtc,
  localTimeToUtc,
  utcOffsetForTime,
} from '@edusupervise/worker/timezone';

async function main(): Promise<void> {
  // ---------------------------------------------------------------------
  // DB + Redis bootstrap
  // ---------------------------------------------------------------------
  const RUNTIME_URL =
    process.env.DATABASE_URL ??
    'postgres://edusupervise_runtime:testpw@localhost:5432/edusupervise';
  const SYSTEM_URL =
    process.env.SYSTEM_DATABASE_URL ??
    'postgres://edusupervise_system:testpw@localhost:5432/edusupervise';
  const OWNER_URL =
    process.env.OWNER_DATABASE_URL ??
    'postgres://edusupervise_owner:testpw@localhost:5432/edusupervise';
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const sqlOwner = postgres(OWNER_URL, { max: 5, prepare: false });
  const sys = getSystemClient(SYSTEM_URL);
  const run = getRuntimeClient(RUNTIME_URL);
  const systemDb = sys.db;
  const runtimeDb = run.db;

  type Case = {
    name: string;
    fn: () => Promise<void>;
  };
  const cases: Case[] = [];
  const testWorkers: Array<{ close: () => Promise<void> }> = [];
  const testQueues: Array<{ close: () => Promise<void> }> = [];

  function newTestQueue(): { queue: Queue; redis: IORedis } {
    // Tests enable the offline queue (default `true`); the production
    // worker deliberately disables it so a Redis hiccup doesn't pile up
    // jobs in process memory. The test harness wants the opposite —
    // synchronous-feeling calls that queue commands while the socket
    // is still connecting.
    const redis = new IORedis(REDIS_URL, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    const name = `reminders-test-${randomUUID()}`;
    const queue = new Queue(name, { connection: redis });
    testQueues.push({ close: async () => queue.close() });
    return { queue, redis };
  }
  async function startWorkerWith(
    queue: Queue,
    redis: IORedis,
    processor: Parameters<typeof Worker>[2]['processor'],
  ): Promise<Worker> {
    const w = new Worker(queue.name, processor, {
      connection: redis,
      concurrency: 1,
    });
    // Wait until the worker has subscribed to the queue's stream
    // (`waitUntilReady` resolves on the BullMQ `ready` event). Without
    // this, `queue.add()` may race with worker startup — a job posted
    // before the consumer is bound sits in Redis until the worker
    // starts polling and the test's 5s `waitUntilFinished` timeout
    // fires first.
    await w.waitUntilReady();
    testWorkers.push({ close: async () => w.close() });
    return w;
  }

  async function truncateAll(): Promise<void> {
    await sqlOwner`
      TRUNCATE TABLE
        outbox,
        audit_log,
        notifications,
        reminder_log,
        reminders,
        duty_assignments,
        duties,
        cycle_calendar,
        users,
        schools,
        worker_heartbeats
      RESTART IDENTITY CASCADE
    `;
  }

  const logger = pinoLike({ name: 'worker-test', level: 'silent' });

  // Email/SMS mock adapters try to append to /data/mocks/*.log, which
  // doesn't exist on a dev box. Point them at /tmp so their
  // `mkdir -p` + `appendFile` calls succeed. Without this the email
  // log entry errors are logged but the send still returns — yet
  // some side-effect of the failed mkdir appears to stall the
  // worker's postgres connection during the case 1 + case 5 tests.
  process.env.EMAIL_MOCK_LOG_PATH = '/tmp/worker-test-emails.log';
  process.env.SMS_MOCK_LOG_PATH = '/tmp/worker-test-sms.log';

  interface FixtureBundle {
    schoolId: string;
    adminId: string;
    teacherId: string;
    dutyId: string;
    assignmentId: string;
    reminderId: string;
  }

  async function seedFixture(suffix: string): Promise<FixtureBundle> {
    const start = '2026-09-07';
    const end = '2027-06-30';
    const [school] = await systemDb
      .insert(schools)
      .values({
        slug: `worker-test-school-${suffix}`,
        name: `Worker Test School ${suffix}`,
        timezone: 'America/Toronto',
        cycleDays: 5,
        schoolYearStart: start,
        schoolYearEnd: end,
        plan: 'trial',
      })
      .returning();
    if (!school) throw new Error('seedFixture: school insert failed');

    const [admin] = await systemDb
      .insert(users)
      .values({
        schoolId: school.id,
        email: `admin-${suffix}@school.test`,
        name: 'Admin',
        role: 'school_admin',
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!admin) throw new Error('seedFixture: admin insert failed');

    const [teacher] = await systemDb
      .insert(users)
      .values({
        schoolId: school.id,
        email: `teacher-${suffix}@school.test`,
        name: 'Teacher',
        role: 'teacher',
        emailVerifiedAt: new Date(),
        phone: '+15551112233',
      })
      .returning();
    if (!teacher) throw new Error('seedFixture: teacher insert failed');

    const [duty] = await systemDb
      .insert(duties)
      .values({
        schoolId: school.id,
        cycleDay: 1,
        startTime: '08:30:00',
        endTime: '09:00:00',
        location: 'Main Entrance',
        description: 'Morning carloop duty',
        requiresVest: true,
        requiresRadio: false,
        isActive: true,
        createdBy: admin.id,
      })
      .returning();
    if (!duty) throw new Error('seedFixture: duty insert failed');

    const [assignment] = await systemDb
      .insert(dutyAssignments)
      .values({
        schoolId: school.id,
        dutyId: duty.id,
        userId: teacher.id,
        startDate: start,
        endDate: null,
        createdBy: admin.id,
      })
      .returning();
    if (!assignment) throw new Error('seedFixture: assignment insert failed');

    const [reminder] = await systemDb
      .insert(reminders)
      .values({
        schoolId: school.id,
        assignmentId: assignment.id,
        minutesBefore: 10,
        isEnabled: true,
        notifyEmail: true,
        notifySms: false,
        customMessage: null,
      })
      .returning();
    if (!reminder) throw new Error('seedFixture: reminder insert failed');

    return {
      schoolId: school.id,
      adminId: admin.id,
      teacherId: teacher.id,
      dutyId: duty.id,
      assignmentId: assignment.id,
      reminderId: reminder.id,
    };
  }

  // ---------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------

  cases.push({
    name: 'case 1: valid reminder dispatch writes reminder_log',
    fn: async () => {
      const fx = await seedFixture('one');
      await truncateAll(); // ensure no leakage from earlier fixtures
      fx; // (already seeded then truncated — recreate below)
      // re-seed to keep the case self-contained
    },
  });

  // The above pattern is awkward. Let me just write the cases fresh:
  const freshCases: Case[] = [];

  freshCases.push({
    name: 'case 1: valid reminder dispatch writes reminder_log',
    fn: async () => {
      const fx = await seedFixture('one');
      const { queue, redis } = newTestQueue();
      const processor = makeReminderProcessor({ db: systemDb, logger });
      await startWorkerWith(queue, redis, processor);
      const scheduledFor = '2026-09-14T13:00:00.000Z';
      await queue.add(
        'reminder.dispatch',
        {
          schoolId: fx.schoolId,
          reminderId: fx.reminderId,
          assignmentId: fx.assignmentId,
          userId: fx.teacherId,
          channel: 'email',
          scheduledFor,
        },
        { removeOnComplete: true, removeOnFail: true },
      );

      // Poll the DB until the worker writes the reminder_log row.
      // BullMQ's `waitUntilFinished(job, timeout)` blocks on the
      // queue's pub/sub connection, but our tests publish on the
      // worker's connection — they differ when each side makes its
      // own ioredis subscriber. Polling bypasses the cross-channel
      // race entirely.
      const deadline = Date.now() + 6_000;
      let rows: typeof reminderLog.$inferSelect[] = [];
      while (Date.now() < deadline) {
        rows = await systemDb
          .select()
          .from(reminderLog)
          .where(eq(reminderLog.reminderId, fx.reminderId));
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (rows.length !== 1) {
        throw new Error(`expected 1 reminder_log row, got ${rows.length}`);
      }
      const row = rows[0]!;
      if (row.status !== 'sent') throw new Error(`status=${row.status}`);
      if (row.channel !== 'email') throw new Error(`channel=${row.channel}`);
      if (row.schoolId !== fx.schoolId) throw new Error('wrong schoolId');
      if (row.userId !== fx.teacherId) throw new Error('wrong userId');
      if (row.assignmentId !== fx.assignmentId) throw new Error('wrong assignmentId');
      if (row.error != null) throw new Error(`error should be null: ${row.error}`);
      if (row.sentAt == null) throw new Error('sentAt should be set');
      if (row.attempts !== 1) throw new Error(`attempts=${row.attempts}`);
    },
  });

  freshCases.push({
    name: 'case 2a: invalid payload (missing schoolId) is rejected before any DB write',
    fn: async () => {
      const fx = await seedFixture('two');
      const processor = makeReminderProcessor({ db: systemDb, logger });
      const before = await systemDb
        .select({ id: reminderLog.id })
        .from(reminderLog);
      const fakeJob = {
        id: 'fake-bad',
        data: {
          reminderId: fx.reminderId,
          assignmentId: fx.assignmentId,
          userId: fx.teacherId,
          channel: 'email',
          scheduledFor: '2026-09-14T13:00:00.000Z',
        },
        attemptsMade: 0,
      } as unknown as Job;
      let threw = false;
      try {
        await processor(fakeJob);
      } catch (e) {
        threw = e instanceof InvalidPayloadError;
      }
      if (!threw) throw new Error('expected InvalidPayloadError');
      const after = await systemDb
        .select({ id: reminderLog.id })
        .from(reminderLog);
      if (after.length !== before.length) {
        throw new Error(
          `expected reminder_log count unchanged (was ${before.length}, now ${after.length})`,
        );
      }
    },
  });

  freshCases.push({
    name: 'case 2b: invalid payload (bad UUID format) is rejected',
    fn: async () => {
      const processor = makeReminderProcessor({ db: systemDb, logger });
      const badJob = {
        id: 'fake-bad-2',
        data: {
          schoolId: 'not-a-uuid',
          reminderId: randomUUID(),
          assignmentId: randomUUID(),
          userId: randomUUID(),
          channel: 'email',
          scheduledFor: '2026-09-14T13:00:00.000Z',
        },
        attemptsMade: 0,
      } as unknown as Job;
      let threw = false;
      try {
        await processor(badJob);
      } catch (e) {
        threw = e instanceof InvalidPayloadError;
      }
      if (!threw) throw new Error('expected InvalidPayloadError');
    },
  });

  freshCases.push({
    name: 'case 3a: terminal failure writes reminder_log + audit_log + notification',
    fn: async () => {
      const fx = await seedFixture('three');
      const payload = {
        schoolId: fx.schoolId,
        reminderId: fx.reminderId,
        assignmentId: fx.assignmentId,
        userId: fx.teacherId,
        channel: 'email',
        scheduledFor: '2026-09-14T13:00:00.000Z',
      };
      await onFinalFailure({
        db: systemDb,
        logger,
        payload,
        error: new Error('simulated email gateway 500'),
      });

      const logs = await systemDb
        .select()
        .from(reminderLog)
        .where(eq(reminderLog.reminderId, fx.reminderId));
      if (logs.length !== 1) throw new Error(`expected 1 log, got ${logs.length}`);
      if (logs[0]!.status !== 'failed') throw new Error('status=failed');
      if (logs[0]!.error !== 'simulated email gateway 500') {
        throw new Error(`error=${logs[0]!.error}`);
      }
      if (logs[0]!.attempts !== 5) throw new Error(`attempts=${logs[0]!.attempts}`);

      const audits = await systemDb
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'reminder.failed'));
      if (audits.length !== 1) throw new Error(`expected 1 audit, got ${audits.length}`);
      if (audits[0]!.userId !== null) throw new Error('userId should be null');
      if (audits[0]!.schoolId !== fx.schoolId) throw new Error('wrong audit schoolId');

      const notifs = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.kind, 'reminder.failed'));
      if (notifs.length !== 1) throw new Error(`expected 1 notif, got ${notifs.length}`);
      if (notifs[0]!.userId !== fx.teacherId) throw new Error('wrong notif userId');
      if (notifs[0]!.title !== 'Reminder failed to send') {
        throw new Error(`title=${notifs[0]!.title}`);
      }
      if (notifs[0]!.linkUrl !== '/app/reminders') {
        throw new Error(`linkUrl=${notifs[0]!.linkUrl}`);
      }
    },
  });

  freshCases.push({
    name: 'case 3b: isFinalFailure returns true only at attempts>=5',
    fn: async () => {
      if (isFinalFailure({ attemptsMade: 0 })) throw new Error('0 should not be final');
      if (isFinalFailure({ attemptsMade: 4 })) throw new Error('4 should not be final');
      if (!isFinalFailure({ attemptsMade: 5 })) throw new Error('5 should be final');
      if (!isFinalFailure({ attemptsMade: 6 })) throw new Error('6 should be final');
    },
  });

  freshCases.push({
    name: 'case 4: reminder_log RLS — school B cannot read school A row',
    fn: async () => {
      const a = await seedFixture('A');
      const b = await seedFixture('B');
      await onFinalFailure({
        db: systemDb,
        logger,
        payload: {
          schoolId: a.schoolId,
          reminderId: a.reminderId,
          assignmentId: a.assignmentId,
          userId: a.teacherId,
          channel: 'email',
          scheduledFor: '2026-09-14T13:00:00.000Z',
        },
        error: new Error('simulated for RLS test'),
      });

      const fromA = await withSchoolContext(runtimeDb, a.schoolId, async (tx) => {
        return tx
          .select()
          .from(reminderLog)
          .where(eq(reminderLog.reminderId, a.reminderId));
      });
      if (fromA.length !== 1) throw new Error(`A should see 1, got ${fromA.length}`);

      const fromB = await withSchoolContext(runtimeDb, b.schoolId, async (tx) => {
        return tx.select().from(reminderLog);
      });
      if (fromB.length !== 0) {
        throw new Error(`B should see 0 reminder_log rows, got ${fromB.length}`);
      }

      const bNotifs = await withSchoolContext(runtimeDb, b.schoolId, async (tx) => {
        return tx
          .select()
          .from(notifications)
          .where(eq(notifications.kind, 'reminder.failed'));
      });
      if (bNotifs.length !== 0) {
        throw new Error(`B should see 0 notifications, got ${bNotifs.length}`);
      }
    },
  });

  freshCases.push({
    name: 'case 5: concurrent jobs across two schools write to correct school_id',
    fn: async () => {
      const a = await seedFixture('concA');
      const b = await seedFixture('concB');
      const { queue, redis } = newTestQueue();
      const processor = makeReminderProcessor({ db: systemDb, logger });
      await startWorkerWith(queue, redis, processor);

      const scheduledA = '2026-09-14T13:00:00.000Z';
      const scheduledB = '2026-09-21T13:00:00.000Z';
      await Promise.all([
        queue.add(
          'reminder.dispatch',
          {
            schoolId: a.schoolId,
            reminderId: a.reminderId,
            assignmentId: a.assignmentId,
            userId: a.teacherId,
            channel: 'email',
            scheduledFor: scheduledA,
          },
          { removeOnComplete: true, removeOnFail: true },
        ),
        queue.add(
          'reminder.dispatch',
          {
            schoolId: b.schoolId,
            reminderId: b.reminderId,
            assignmentId: b.assignmentId,
            userId: b.teacherId,
            channel: 'email',
            scheduledFor: scheduledB,
          },
          { removeOnComplete: true, removeOnFail: true },
        ),
      ]);

      // Poll the DB until both rows are written (see case 1's comment).
      const deadline = Date.now() + 6_000;
      let rows: typeof reminderLog.$inferSelect[] = [];
      while (Date.now() < deadline) {
        rows = await systemDb.select().from(reminderLog);
        if (
          rows.find((r) => r.reminderId === a.reminderId) &&
          rows.find((r) => r.reminderId === b.reminderId)
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const rowA = rows.find((r) => r.reminderId === a.reminderId);
      const rowB = rows.find((r) => r.reminderId === b.reminderId);
      if (!rowA || !rowB) throw new Error('expected rows for both schools');
      if (rowA.schoolId !== a.schoolId || rowB.schoolId !== b.schoolId) {
        throw new Error('schoolId mismatch');
      }
    },
  });

  freshCases.push({
    name: 'case 6: heartbeat upsert advances last_beat and increments jobs_completed',
    fn: async () => {
      const workerId = `worker-test-${randomUUID()}`;
      await writeHeartbeat({ workerId, db: systemDb, logger, jobsCompleted: 0 });
      const first = await systemDb
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, workerId));
      if (first.length !== 1) throw new Error('expected 1 heartbeat');
      const t1 = first[0]!.lastBeat;
      const jobs1 = first[0]!.jobsCompleted;
      if (jobs1 !== BigInt(0)) throw new Error(`jobs1=${jobs1}`);

      await new Promise((r) => setTimeout(r, 30));

      await writeHeartbeat({
        workerId,
        db: systemDb,
        logger,
        jobsCompleted: 3,
      });
      const second = await systemDb
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, workerId));
      if (second.length !== 1) throw new Error('expected 1 heartbeat');
      const t2 = second[0]!.lastBeat;
      const jobs2 = second[0]!.jobsCompleted;
      if (new Date(t2).getTime() < new Date(t1).getTime()) {
        throw new Error('last_beat did not advance');
      }
      if (jobs2 !== BigInt(3)) throw new Error(`jobs2=${jobs2}`);
    },
  });

  freshCases.push({
    name: 'tz: utcOffsetForTime returns 0 for UTC and -240 for America/Toronto in June',
    fn: async () => {
      if (utcOffsetForTime(new Date('2026-06-15T12:00:00Z'), 'UTC') !== 0) {
        throw new Error('UTC offset should be 0');
      }
      if (
        utcOffsetForTime(new Date('2026-06-15T12:00:00Z'), 'America/Toronto') !== -240
      ) {
        throw new Error('Toronto June offset should be -240');
      }
      if (
        utcOffsetForTime(new Date('2026-01-15T12:00:00Z'), 'America/Toronto') !== -300
      ) {
        throw new Error('Toronto January offset should be -300');
      }
    },
  });

  freshCases.push({
    name: 'tz: localTimeToUtc + dispatchAtUtc round-trip',
    fn: async () => {
      const utc = localTimeToUtc(
        { year: 2026, month: 6, day: 15 },
        '09:00',
        'America/Toronto',
      );
      if (utc.toISOString() !== '2026-06-15T13:00:00.000Z') {
        throw new Error(`expected 2026-06-15T13:00:00Z, got ${utc.toISOString()}`);
      }
      const dispatch = dispatchAtUtc({
        date: { year: 2026, month: 6, day: 15 },
        localStart: '09:00',
        minutesBefore: 10,
        tz: 'America/Toronto',
      });
      if (dispatch.toISOString() !== '2026-06-15T12:50:00.000Z') {
        throw new Error(`dispatch=${dispatch.toISOString()}`);
      }
    },
  });

  // ---------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; err: Error }> = [];

  // Initial cleanup + per-case cleanup.
  for (const c of freshCases) {
    await truncateAll();
    for (const w of testWorkers.splice(0)) {
      try { await w.close(); } catch { /* best-effort */ }
    }
    for (const q of testQueues.splice(0)) {
      try { await q.close(); } catch { /* best-effort */ }
    }
    try {
      await c.fn();
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${c.name}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${c.name}\n`);
      const e = err instanceof Error ? err : new Error(String(err));
      process.stdout.write(`      ${e.message}\n`);
      failed++;
      failures.push({ name: c.name, err: e });
    }
  }

  await sqlOwner.end({ timeout: 5 });
  await sys.close();
  await run.close();

  process.stdout.write(
    `\n\x1b[1mTest Files\x1b[0m  ${failed > 0 ? '1 failed' : '1 passed'} (1)\n` +
    `\x1b[1m     Tests\x1b[0m  ${failed} failed | ${passed} passed (${passed + failed})\n`,
  );
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  process.stderr.write(`\nworker-tests fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
