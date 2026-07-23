/**
 * Outbox flusher: every 5s reads `outbox` rows where `enqueued_at IS NULL`,
 * enqueues them as BullMQ jobs on the `reminders` queue, and marks the
 * row as enqueued (`enqueued_at = now()`).
 *
 * Spec section 2 ("Request flow — typical web mutation") mandates this
 * loop: the web mutation writes an outbox row in the same transaction as
 * the data change; the worker picks it up off-transaction, enqueues to
 * BullMQ, and stamps `enqueued_at` so the next poll skips the row.
 *
 * Why the worker does the enqueue, not the web server:
 *   - The web server doesn't necessarily have Redis access. Putting
 *     BullMQ enqueue in the worker keeps the dependency surface tight
 *     (web → Postgres only, worker → Postgres + Redis).
 *   - It also gives the worker a single, observable bottleneck for
 *     "the queue" — operators tail the outbox flush log to see
 *     backlog/throughput.
 *
 * Safety net: each outbox row enqueue is wrapped in a try/catch. A
 * failure to enqueue leaves `enqueued_at` NULL so the next poll
 * retries it. The `payload` is a `ReminderJobPayload`; we re-validate
 * on enqueue (per spec section 10). If re-validation fails, we write a
 * system-side audit row tagging the entry as poison and skip the row.
 */

import type { Queue } from 'bullmq';
import { eq, isNull, sql, asc } from 'drizzle-orm';
import type { Db } from '@edusupervise/db';
import { outbox, auditLog } from '@edusupervise/db';
import type { Logger } from '../logger.js';
import {
  QUEUE_NAME,
  JOB_NAME_DISPATCH,
  REMINDER_JOB_OPTIONS,
} from '../retry-policy.js';
import { reminderJobSchema } from './reminders.js';
import type { ReminderJobPayload } from './reminders.js';

export interface OutboxFlushOpts {
  db: Db;
  queue: Queue;
  logger: Logger;
  /** Cap on rows per poll. Default 100. Keeps the loop bounded under
   *  sustained backlog. */
  batchSize?: number;
}

/**
 * Run one outbox flush cycle. Returns the number of rows successfully
 * enqueued. Errors at the flush level are caught and logged; we never
 * throw out of `flushOutboxOnce` because a thrown loop iteration would
 * kill the worker (uncaughtError in setInterval).
 */
export async function flushOutboxOnce(
  opts: OutboxFlushOpts,
): Promise<number> {
  const batchSize = opts.batchSize ?? 100;

  const rows = await opts.db
    .select({
      id: outbox.id,
      schoolId: outbox.schoolId,
      jobType: outbox.jobType,
      payload: outbox.payload,
    })
    .from(outbox)
    .where(isNull(outbox.enqueuedAt))
    .orderBy(asc(outbox.createdAt))
    .limit(batchSize);

  if (rows.length === 0) return 0;

  let enqueued = 0;
  for (const row of rows) {
    try {
      // Re-validate on enqueue (spec section 10). If it's a known
      // jobType and validates, push to BullMQ; otherwise tag the row
      // as poison + write an audit row so an operator can clean up.
      if (row.jobType !== JOB_NAME_DISPATCH) {
        await markPoisonRow(opts, row.id, `unknown jobType: ${row.jobType}`);
        continue;
      }

      const parseResult = reminderJobSchema.safeParse(row.payload);
      if (!parseResult.success) {
        const issues = parseResult.error.issues
          .map((i: { path: (string | number)[]; message: string }) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ');
        await markPoisonRow(opts, row.id, `invalid payload: ${issues}`);
        continue;
      }

      await opts.queue.add(JOB_NAME_DISPATCH, parseResult.data, {
        ...REMINDER_JOB_OPTIONS,
        jobId: `outbox-${row.id.toString()}`,
      });

        // Mark only the row we just enqueued. The deterministic BullMQ
        // job id keeps a retry safe if this stamp fails after queue.add.
        await opts.db.execute(sql`
          UPDATE outbox
          SET enqueued_at = now()
          WHERE id = ${row.id}
            AND enqueued_at IS NULL
        `);

      enqueued++;
      opts.logger.debug(
        { id: row.id.toString(), schoolId: row.schoolId, jobType: row.jobType },
        'outbox row enqueued',
      );
    } catch (err) {
      opts.logger.error(
        { err, id: row.id.toString(), jobType: row.jobType },
        'outbox enqueue failed; will retry next poll',
      );
    }
  }

  if (enqueued > 0) {
    opts.logger.info(
      { enqueued, batch: rows.length },
      'outbox flush complete',
    );
  }
  return enqueued;
}

/**
 * Tag a row as poison so the flush loop skips it. We don't delete —
 * an operator might want to inspect; removing it silently makes
 * debugging impossible.
 */
async function markPoisonRow(
  opts: OutboxFlushOpts,
  id: bigint,
  reason: string,
): Promise<void> {
  try {
    await opts.db.transaction(async (tx) => {
      const row = await tx
        .select({ schoolId: outbox.schoolId, jobType: outbox.jobType })
        .from(outbox)
        .where(eq(outbox.id, id))
        .limit(1);
      const found = row[0];
      if (!found) return;
      await tx.execute(
        sql`SELECT set_config('app.school_id', ${found.schoolId}, true)`,
      );
      await tx
        .update(outbox)
        .set({ enqueuedAt: new Date() })
        .where(eq(outbox.id, id));
      await tx.insert(auditLog).values({
        schoolId: found.schoolId,
        userId: null,
        action: 'outbox.poison',
        targetType: 'outbox',
        targetId: null,
        metadata: {
          outboxId: id.toString(),
          jobType: found.jobType,
          reason,
        },
        ipAddress: null,
        userAgent: null,
      });
    });
    opts.logger.warn(
      { id: id.toString(), reason },
      'outbox row tagged as poison',
    );
  } catch (err) {
    opts.logger.error(
      { err, id: id.toString(), reason },
      'failed to mark outbox row as poison',
    );
  }
}

/**
 * Run `flushOutboxOnce` on a fixed interval. Same pattern as the
 * heartbeat loop — opaque handle with `.stop()` for clean shutdown.
 */
export function startOutboxFlushLoop(
  opts: OutboxFlushOpts & { intervalMs?: number },
): { stop: () => Promise<void> } {
  const intervalMs = opts.intervalMs ?? 5_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await flushOutboxOnce(opts);
    } catch (err) {
      opts.logger.error({ err }, 'outbox flush cycle failed');
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  // Initial flush so a fresh startup doesn't have to wait `intervalMs`
  // for the first pass.
  void tick();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
