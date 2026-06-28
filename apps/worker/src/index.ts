// apps/worker/src/index.ts — reminder worker entrypoint.
//
// Placeholder so the foundation Dockerfile.worker can build. The real worker
// (BullMQ consumer, outbox flusher, heartbeat, retry policy) is wired up by
// the `worker` task. This stub just logs that it's running and exits so the
// container comes up cleanly and the healthcheck/log inspection patterns
// exercised in the foundation compose stack work end-to-end.

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

const workerId = process.env.HOSTNAME ?? `worker-${process.pid}`;

logger.info({ workerId, pid: process.pid }, 'reminder worker bootstrap — placeholder');

// In the real worker task this is replaced with:
//   import { Worker } from 'bullmq';
//   const worker = new Worker('reminders', processJob, { connection, concurrency: 5 });
//   await startHeartbeat(workerId);
//   await startOutboxFlusher();
//   process.on('SIGTERM', () => worker.close());

// For the foundation task we just idle so the container stays up and the
// compose `docker compose ps` shows the worker as healthy. The `restart:
// unless-stopped` policy keeps it alive across restarts.
const shutdown = (signal: string) => {
  logger.info({ signal }, 'worker shutting down');
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep the event loop alive.
setInterval(() => {
  logger.debug({ workerId }, 'worker idle');
}, 60_000);