/**
 * Drizzle client factories — runtime role and system role.
 *
 * Three Postgres roles exist (see `db/init/00-create-roles.sh` and
 * `db/init/01-schema.sql`):
 *
 *   - `edusupervise_owner`  — table-owning role; used by migrations only.
 *   - `edusupervise_runtime` — web container. Does NOT own tables and does
 *                             NOT have `BYPASSRLS`, so `FORCE ROW LEVEL
 *                             SECURITY` applies. Must always be inside a
 *                             transaction with `SET LOCAL app.school_id`
 *                             set (see `rls.ts`).
 *   - `edusupervise_system`  — worker, cron, webhooks. Has `BYPASSRLS` so
 *                             it can write to system-only tables
 *                             (`stripe_events`, `worker_heartbeats`,
 *                             `audit_log` for system actions). The worker
 *                             still sets `app.school_id` defensively for
 *                             every tenant-table query.
 *
 * The two factories below return a `pg` connection + a Drizzle ORM wrapper.
 * They take the connection string at the call site so the same code can
 * connect to local dev, staging, or production without rebuilding the
 * client.
 *
 * Pool sizing:
 *   - `max: 10` is the default for the web runtime. RR7 actions open one
 *     short-lived transaction per request, so 10 connections is plenty for
 *     a single web container handling ~100 RPS.
 *   - The system pool is a SINGLE pool used by the worker for the whole
 *     container lifetime. The BullMQ worker recommends `max >= concurrency`,
 *     so 10 here matches the default 5 worker concurrency with headroom.
 *
 * Driver: `postgres` (postgres.js). Per spec section 3 we use it instead of
 * `pg` because it is lighter, has built-in prepared-statement caching, and
 * supports transactions with `BEGIN`/`COMMIT` directly (Drizzle's
 * `db.transaction` maps onto that).
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, type schema as schemaType } from './schema.js';

export type Db = PostgresJsDatabase<typeof schemaType>;

export interface ClientOptions {
  /** Maximum pool size. Default 10. */
  max?: number;
  /** Optional logger for query debugging. */
  debug?: boolean;
}

const DEFAULT_MAX = 10;

/**
 * Build a runtime client. The runtime role does NOT have `BYPASSRLS`, so
 * every tenant query MUST be inside a `withSchoolContext` transaction.
 *
 * The returned `close` function drains the pool — call it on process
 * shutdown to flush prepared statements cleanly.
 */
export function getRuntimeClient(
  databaseUrl: string,
  options: ClientOptions = {},
): { db: Db; close: () => Promise<void> } {
  const sql = postgres(databaseUrl, {
    max: options.max ?? DEFAULT_MAX,
    debug: options.debug ?? false,
    // postgres.js defaults are fine for the runtime role; we do not pass
    // `no_prepare: true` because the runtime role does not own tables
    // (PREPARE works against any role with SELECT permission).
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Build a system client. The system role has `BYPASSRLS` and is the only
 * role permitted to write to `stripe_events`, `worker_heartbeats`, and
 * system-initiated `audit_log` rows.
 *
 * Workers should use this client and STILL call `withSchoolContext` for
 * tenant-table queries so behavior is consistent with the runtime path
 * (the system role's `BYPASSRLS` is only needed for system tables).
 */
export function getSystemClient(
  databaseUrl: string,
  options: ClientOptions = {},
): { db: Db; close: () => Promise<void> } {
  const sql = postgres(databaseUrl, {
    max: options.max ?? DEFAULT_MAX,
    debug: options.debug ?? false,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Re-export the schema so consumers can `import { db, schema }` from a
 * single entry point.
 */
export { schema };
