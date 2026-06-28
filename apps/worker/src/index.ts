// apps/web/src/db.server.ts is the runtime Drizzle client used by the web app.
// The worker uses packages/db/src/client.ts (system role) for its connection.

// apps/worker/src/index.ts — reminder worker.
//
// Tier 1 implementation: a polling loop that reads outbox rows that have not
// been enqueued, dispatches them via @edusupervise/email (mock by default),
// and marks them enqueued. A real BullMQ + retry policy is layered on top in
// the next sprint.

import pino from 'pino';
import { sql, eq, isNull, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@edusupervise/db';
import { sendEmail } from '@edusupervise/email';
import { outbox } from '@edusupervise/db';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { workerId: process.env.HOSTNAME ?? `worker-${process.pid}` },
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  logger.fatal('DATABASE_URL is not set');
  process.exit(1);
}

const client = postgres(DATABASE_URL, { max: 5, prepare: false });
const db = drizzle(client, { schema });

async function heartbeat() {
  const workerId = process.env.HOSTNAME ?? `worker-${process.pid}`;
  try {
    await db.execute(sql`
      INSERT INTO worker_heartbeats (worker_id, last_beat, started_at)
      VALUES (${workerId}, now(), now())
      ON CONFLICT (worker_id) DO UPDATE SET last_beat = now()
    `);
  } catch (err) {
    logger.warn({ err }, 'heartbeat failed');
  }
}

interface OutboxRow {
  id: bigint;
  schoolId: string;
  jobType: string;
  payload: unknown;
}

async function dispatchOutboxRow(row: OutboxRow) {
  logger.info({ id: row.id, jobType: row.jobType, schoolId: row.schoolId }, 'dispatching outbox row');
  if (row.jobType === 'reminder.dispatch') {
    const { to, subject, body } = row.payload as { to?: string; subject?: string; body?: string };
    if (!to || !subject) {
      logger.warn({ id: row.id }, 'reminder.dispatch missing to/subject; skipping');
      return;
    }
    const result = await sendEmail({ to, subject, body: body ?? '' });
    logger.info({ id: row.id, providerId: result.providerId, status: result.status }, 'sent');
  } else {
    logger.warn({ id: row.id, jobType: row.jobType }, 'unknown job type; skipping');
  }
}

async function pollOutbox() {
  try {
    const rows = await db
      .select({
        id: outbox.id,
        schoolId: outbox.schoolId,
        jobType: outbox.jobType,
        payload: outbox.payload,
      })
      .from(outbox)
      .where(isNull(outbox.enqueuedAt))
      .limit(20);

    for (const row of rows) {
      try {
        await dispatchOutboxRow(row);
        await db
          .update(outbox)
          .set({ enqueuedAt: new Date() })
          .where(eq(outbox.id, row.id));
      } catch (err) {
        logger.error({ id: row.id, err }, 'dispatch failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'outbox poll failed');
  }
}

async function main() {
  logger.info({ pid: process.pid }, 'reminder worker started');
  await heartbeat();

  const heartbeatInterval = setInterval(() => void heartbeat(), 30_000);
  const pollInterval = setInterval(() => void pollOutbox(), 5_000);
  await pollOutbox(); // initial flush

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    clearInterval(heartbeatInterval);
    clearInterval(pollInterval);
    client.end().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker startup failed');
  process.exit(1);
});