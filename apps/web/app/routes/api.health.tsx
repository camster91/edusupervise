// apps/web/app/routes/api.health.tsx
import type { Route } from './+types/api.health';
import { sql } from 'drizzle-orm';
import { getSystemClient } from '@edusupervise/db';
import { getDb } from '../../server/db.server.ts';

const WORKER_FRESHNESS_SEC = 90;

export async function loader(_: Route.LoaderArgs) {
  // 1. DB ping (runtime role, FORCE RLS) — quick fail-closed check.
  let dbOk = false;
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // 2. Worker heartbeat freshness. The worker emits a heartbeat into
  // worker_heartbeats every <interval> seconds. If no worker has beat
  // in the last WORKER_FRESHNESS_SEC, /api/health reports workers=degraded
  // so the dashboard / monitoring can pick it up. We deliberately do
  // NOT flip the HTTP status to 5xx — a stalled worker is not a
  // "the app is down" condition; the web container is still serving
  // requests. The route still returns 200 in all cases.
  let workers: 'ok' | 'degraded' | 'unknown' = 'unknown';
  let worker_age_seconds = -1;
  if (dbOk) {
    try {
      const systemUrl = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
      if (systemUrl) {
        const { db: sysDb, close } = getSystemClient(systemUrl);
        try {
          const result = await sysDb.execute(
            sql`SELECT EXTRACT(EPOCH FROM (now() - MAX(last_beat)))::int AS age_seconds FROM worker_heartbeats`,
          );
          const rows = Array.isArray(result) ? result : (result as { rows?: Array<{ age_seconds?: number }> }).rows ?? [];
          const age = Number(rows[0]?.age_seconds ?? -1);
          worker_age_seconds = age;
          if (age < 0) {
            workers = 'unknown';
          } else if (age > WORKER_FRESHNESS_SEC) {
            workers = 'degraded';
          } else {
            workers = 'ok';
          }
        } finally {
          await close();
        }
      }
    } catch {
      workers = 'unknown';
    }
  }

  const overallStatus = dbOk && workers !== 'degraded' ? 'ok' : 'degraded';
  return Response.json({
    status: overallStatus,
    db: dbOk ? 'ok' : 'down',
    uptime_s: Math.floor(process.uptime()),
    workers,
    worker_age_seconds,
  });
}
