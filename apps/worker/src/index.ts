/**
 * apps/worker/src/index.ts — Tier 1 reminder worker entrypoint.
 *
 * Boots three components in order:
 *   1. Postgres system-role connection (BYPASSRLS) for reminder_log,
 *      audit_log, worker_heartbeats, outbox writes.
 *   2. BullMQ Worker on the `reminders` queue with concurrency 5
 *      (spec section 10). Wired to the `reminder.dispatch` processor
 *      with the 1m/5m/30m/2h/12h backoff schedule.
 *   3. Heartbeat loop (30s, INSERT ... ON CONFLICT) and outbox-flush loop
 *      (5s, reads `outbox` and enqueues jobs).
 *
 * SIGTERM / SIGINT — drain everything cleanly: stop the loops, close
 * the BullMQ worker + queue, end the Postgres pool.
 */
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { getSystemClient, type Db } from '@edusupervise/db';

import { pinoLike, type Logger } from './logger.js';
import { startHeartbeatLoop, writeHeartbeat } from './heartbeat.js';
import {
  QUEUE_NAME,
  TOTAL_ATTEMPTS,
  isFinalFailure,
  onFinalFailure,
  reminderBackoff,
} from './retry-policy.js';
import {
  makeReminderProcessor,
  InvalidPayloadError,
  reminderJobSchema,
  type ReminderJobPayload,
} from './jobs/reminders.js';
import { startOutboxFlushLoop } from './jobs/outbox-flush.js';
import { startReminderSchedulerLoop } from './jobs/reminder-scheduler.js';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const DATABASE_URL = readEnv('DATABASE_URL') ?? readEnv('SYSTEM_DATABASE_URL');
const REDIS_URL = readEnv('REDIS_URL');
const CONCURRENCY = Number.parseInt(
  readEnv('WORKER_CONCURRENCY') ?? '5',
  10,
);
const HEARTBEAT_INTERVAL_MS = Number.parseInt(
  readEnv('HEARTBEAT_INTERVAL_MS') ?? '30000',
  10,
);
const OUTBOX_INTERVAL_MS = Number.parseInt(
  readEnv('OUTBOX_INTERVAL_MS') ?? '5000',
  10,
);
const SCHEDULER_INTERVAL_MS = Number.parseInt(
  readEnv('SCHEDULER_INTERVAL_MS') ?? '60000',
  10,
);
const WORKER_ID = readEnv('HOSTNAME') ?? `worker-${process.pid}`;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('[worker] DATABASE_URL (or SYSTEM_DATABASE_URL) is required');
  process.exit(1);
}
if (!REDIS_URL) {
  // eslint-disable-next-line no-console
  console.error('[worker] REDIS_URL is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger: Logger = pinoLike({
  name: '@edusupervise/worker',
  level: process.env.LOG_LEVEL ?? 'info',
  workerId: WORKER_ID,
});

// ---------------------------------------------------------------------------
// Postgres + Redis
// ---------------------------------------------------------------------------

let _db: Db | null = null;
let _closeDb: (() => Promise<void>) | null = null;
function getDb(): Db {
  if (_db) return _db;
  const sys = getSystemClient(DATABASE_URL!);
  _db = sys.db;
  _closeDb = sys.close;
  return _db;
}

function buildRedis(db: number): IORedis {
  return new IORedis(REDIS_URL!, {
    // BullMQ recommends a dedicated DB to avoid noisy neighbor problems;
    // operators can override via REDIS_DB if they share Redis with other
    // apps.
    db,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
  });
}

/**
 * BullMQ's `ConnectionOptions` type models a discrete object — it does
 * NOT type-check cleanly against a `Redis` instance when pnpm installs
 * multiple ioredis versions (the constructor returns a different
 * TS-class identity than BullMQ was bundled against). Pass the same
 * instance back to BullMQ as a connection and the runtime works fine;
 * a 30-line cast avoids the cross-package type mismatch.
 */
function asBullMqConnection(redis: RedisType): RedisType {
  return redis;
}

/**
 * Coerce a job's data into a ReminderJobPayload for terminal bookkeeping.
 * If the payload is too malformed for Zod to extract meaningful fields we
 * synthesize a placeholder row whose UUIDs are unique to this job so the
 * audit + notification rows at least point at a real `reminder_log` row
 * for forensics.
 */
function parseOrPlaceholder(data: unknown): ReminderJobPayload {
  const r = reminderJobSchema.safeParse(data);
  if (r.success) return r.data;
  const placeholder = randomUUID();
  return {
    schoolId: placeholder,
    reminderId: placeholder,
    assignmentId: placeholder,
    userId: placeholder,
    channel: 'email',
    scheduledFor: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function main(): Promise<void> {
  const db = getDb();
  const queueRedis = buildRedis(0);
  const workerRedis = buildRedis(0);

  // ioredis can throw "Stream isn't writeable" if .ping() races the
  // TCP handshake. Retry up to 3x with 500ms backoff so the worker
  // doesn't crash-loop on a slow Redis container start.
  let pingOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await queueRedis.ping();
      pingOk = true;
      break;
    } catch (err) {
      logger.warn({ attempt, err: err instanceof Error ? err.message : String(err) }, 'redis ping failed, retrying');
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!pingOk) throw new Error('redis unreachable after 3 attempts');
  logger.info({ workerId: WORKER_ID }, 'redis ping ok');

  // 1) Initial heartbeat so /api/health sees us within seconds.
  try {
    await writeHeartbeat({ workerId: WORKER_ID, db, logger, jobsCompleted: 0 });
  } catch (err) {
    logger.error({ err }, 'initial heartbeat failed (continuing)');
  }

  // 2) BullMQ Queue (used by the outbox flusher to enqueue jobs).
  const queue = new Queue(QUEUE_NAME, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: asBullMqConnection(queueRedis as any) as any,
    defaultJobOptions: {
      attempts: TOTAL_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });

  // 3) BullMQ Worker (concurrency 5 per spec).
  const processor: Processor = makeReminderProcessor({
    db,
    logger: logger.child({ module: 'reminder-processor' }),
  });

  const worker = new Worker<unknown, void, string>(QUEUE_NAME, processor, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: asBullMqConnection(workerRedis as any) as any,
    concurrency: CONCURRENCY,
    settings: {
      backoffStrategy: reminderBackoff,
    },
  });

  // Spec: invalid payloads fail with error: 'invalid_payload' and an
  // audit_log row is written via system role. We throw InvalidPayloadError
  // from the processor; BullMQ turns the throw into a `failed` event.
  // For invalid payloads we skip the terminal-failure bookkeeping because
  // the outbox flusher's `markPoisonRow` already wrote the audit row —
  // writing it twice would double-count.
  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (err instanceof InvalidPayloadError) {
      logger.warn(
        { jobId: job.id, err: err.message },
        'job rejected: invalid_payload',
      );
      return;
    }
    if (isFinalFailure({ attemptsMade: job.attemptsMade })) {
      const parsed = parseOrPlaceholder(job.data);
      await onFinalFailure({
        db,
        logger,
        payload: parsed,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'bullmq worker error');
  });

  worker.on('completed', (job) => {
    if (!job) return;
    logger.debug(
      { jobId: job.id, attemptsMade: job.attemptsMade + 1 },
      'job completed',
    );
  });

  logger.info(
    { queue: QUEUE_NAME, concurrency: CONCURRENCY, workerId: WORKER_ID },
    'worker started',
  );

  // 4) Loops.
  const heartbeat = startHeartbeatLoop({
    workerId: WORKER_ID,
    db,
    logger,
    intervalMs: HEARTBEAT_INTERVAL_MS,
  });

  const outboxFlush = startOutboxFlushLoop({
    db,
    queue,
    logger: logger.child({ module: 'outbox-flush' }),
    intervalMs: OUTBOX_INTERVAL_MS,
  });

  // Reminder scheduler: scans `reminders` table for enabled reminders
  // whose fire-time is in the next 60s, writes matching outbox rows.
  // The outbox-flush loop above then picks them up + enqueues to BullMQ.
  // Without this loop, `reminders` rows are inert — nothing bridges
  // configuration to dispatch.
  const reminderScheduler = startReminderSchedulerLoop({
    db,
    logger: logger.child({ module: 'reminder-scheduler' }),
    intervalMs: SCHEDULER_INTERVAL_MS,
  });

  // 5) Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    try {
      await heartbeat.stop();
    } catch (err) {
      logger.error({ err }, 'heartbeat stop failed');
    }
    try {
      await outboxFlush.stop();
    } catch (err) {
      logger.error({ err }, 'outbox flush stop failed');
    }
    try {
      await reminderScheduler.stop();
    } catch (err) {
      logger.error({ err }, 'reminder scheduler stop failed');
    }
    try {
      await worker.close();
      logger.info('bullmq worker closed');
    } catch (err) {
      logger.error({ err }, 'worker close failed');
    }
    try {
      await queue.close();
      logger.info('bullmq queue closed');
    } catch (err) {
      logger.error({ err }, 'queue close failed');
    }
    try {
      queueRedis.disconnect();
      workerRedis.disconnect();
    } catch (err) {
      logger.error({ err }, 'redis disconnect failed');
    }
    try {
      if (_closeDb) await _closeDb();
    } catch (err) {
      logger.error({ err }, 'postgres pool close failed');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
  });
}

main().catch((err) => {
  logger.error({ err }, 'worker startup failed');
  process.exit(1);
});
