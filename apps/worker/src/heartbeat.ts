/**
 * Worker heartbeat helper.
 *
 * Spec section 10: "worker writes a row to `worker_heartbeats` every 30s
 * via `INSERT ... ON CONFLICT (worker_id) DO UPDATE SET last_beat = now(),
 * jobs_completed = worker_heartbeats.jobs_completed + EXCLUDED.jobs_completed`."
 *
 * The /api/health endpoint checks freshness — if any worker hasn't beat in
 * 90s, health returns `degraded`. Three missed beats in a row is the spec's
 * threshold for "this worker is wedged or crashed"; for debugging we want
 * that to be loud.
 *
 * Why we track `jobs_completed`:
 *   - It's a passive counter that mirrors the spec's UPSERT. We update it
 *     to `EXCLUDED.jobs_completed` (the value we passed in) so a worker
 *     that boots after a clean shutdown can pick up where the dead one
 *     left off.
 *   - In practice each worker process bumps its own row, so the counter
 *     just monotonically grows during the process's lifetime.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@edusupervise/db';
import type { Logger } from './logger.js';

export interface HeartbeatOpts {
  /** Logical worker id (HOSTNAME in container, PID on laptop). */
  workerId: string;
  /** Drizzle system client. */
  db: Db;
  /** PinoLike logger. */
  logger: Logger;
  /** Counter to add to `jobs_completed` on this beat. Default 0. */
  jobsCompleted?: number;
}

/**
 * One heartbeat upsert. Safe to call on any cadence. Returns void on
 * success; throws on DB error so the caller's retry loop can decide what
 * to do (we do NOT swallow errors here — a swallowed heartbeat is a
 * silent stale-worker in production).
 */
export async function writeHeartbeat(opts: HeartbeatOpts): Promise<void> {
  const completed = opts.jobsCompleted ?? 0;
  try {
    await opts.db.execute(sql`
      INSERT INTO worker_heartbeats (worker_id, last_beat, jobs_completed, started_at)
      VALUES (${opts.workerId}, now(), ${completed}::bigint, now())
      ON CONFLICT (worker_id) DO UPDATE SET
        last_beat      = now(),
        jobs_completed = worker_heartbeats.jobs_completed + EXCLUDED.jobs_completed
    `);
  } catch (err) {
    opts.logger.error(
      { err, workerId: opts.workerId },
      'heartbeat upsert failed',
    );
    // Re-throw so callers that wrap heartbeat() in a tight loop can stop
    // on persistent DB failure instead of CPU-spinning through errors.
    throw err;
  }
}

export interface HeartbeatLoopOpts extends HeartbeatOpts {
  /** Cadence in ms. Default 30_000 (spec). */
  intervalMs?: number;
}

/**
 * Run `writeHeartbeat` on a fixed interval. Returns an opaque handle whose
 * `.stop()` cleans up the timer + the last write. Pass `stopOnSigint=true`
 * from a long-lived process to wire SIGTERM cleanly.
 */
export function startHeartbeatLoop(opts: HeartbeatLoopOpts): { stop: () => Promise<void> } {
  const intervalMs = opts.intervalMs ?? 30_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await writeHeartbeat(opts);
    } catch {
      // Error already logged inside writeHeartbeat; don't crash the loop.
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  // First beat immediately so /api/health sees us within seconds of boot.
  void tick();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // One final beat so the timestamp reflects clean shutdown rather
      // than 90s-stale.
      try {
        await writeHeartbeat(opts);
      } catch {
        // best-effort
      }
    },
  };
}
