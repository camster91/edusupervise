// apps/web/server/db.server.ts
//
// Runtime Drizzle client + withSchoolContext wrapper. Every query that touches
// tenant data goes through withSchoolContext which opens a transaction and
// runs `SET LOCAL app.school_id` before invoking the callback. RLS does the
// rest.

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@edusupervise/db';

let cached: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 10, prepare: false });
  cached = drizzle(client, { schema });
  return cached;
}

export async function withSchoolContext<T>(
  schoolId: string,
  fn: (tx: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true)`);
    return fn(tx as ReturnType<typeof drizzle<typeof schema>>);
  });
}

export { schema };