// apps/web/app/routes/api.health.tsx
import type { Route } from './+types/api.health';
import { sql } from 'drizzle-orm';
import { getDb } from '~/server/db.server';

export async function loader(_: Route.LoaderArgs) {
  let dbOk = false;
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return Response.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'down',
    uptime_s: Math.floor(process.uptime()),
  });
}