/**
 * RLS-aware transaction helper.
 *
 * Every request that touches tenant data MUST run inside a transaction
 * that has set `app.school_id` to the authenticated school. This is
 * enforced by `FORCE ROW LEVEL SECURITY` on every tenant table — even
 * though the runtime role does not own tables, FORCE means RLS policies
 * apply to the runtime role's queries. If `app.school_id` is unset (or
 * set to the wrong school), every query returns zero rows.
 *
 * Usage:
 *
 *   const rows = await withSchoolContext(db, session.schoolId, async (tx) => {
 *     return tx.select().from(schoolsTable).where(eq(schoolsTable.id, ...));
 *   });
 *
 * `withSchoolContext` opens a transaction, runs
 * `set_config('app.school_id', ${schoolId}, true)` (which is bound to the
 * transaction and discarded at COMMIT/ROLLBACK — no leakage to other
 * requests sharing the pool), then invokes the callback with a
 * transaction-scoped Drizzle client.
 *
 * Why `set_config(..., true)` and not `SET LOCAL`?
 *   - Both are transaction-scoped. `set_config('app.school_id', $1, true)`
 *     is the parameterized form of `SET LOCAL` and binds the value safely
 *     (no string interpolation, no SQL injection vector if `schoolId`
 *     ever became a non-UUID). With a connection pool, `SET LOCAL` (or
 *     `set_config(..., true)`) is the only safe option — `SET` would
 *     persist across the same connection's next transaction and could
 *     leak school A's context into school B's request.
 *
 * Why no advisory lock:
 *   - The transaction itself serializes all writes for this connection.
 *     RLS is a per-query filter, not a per-school lock. Two simultaneous
 *     transactions for the same school can interleave writes; the
 *     database's MVCC + the explicit `app.school_id` check are sufficient
 *     to keep data correct.
 */
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import {
  type PgQueryResultHKT,
  type PgTransaction,
} from 'drizzle-orm/pg-core';
import { type schema as schemaType } from './schema.js';
import type { Db } from './client.js';

/**
 * The transaction callback receives a Drizzle `tx` client that has the
 * same `schema` namespace as the parent connection but is bound to the
 * open transaction. Use it for all reads + writes within the school
 * context.
 */
export type SchoolContextTx = PgTransaction<
  PgQueryResultHKT,
  typeof schemaType,
  ExtractTablesWithRelations<typeof schemaType>
>;

export interface WithSchoolContextOptions {
  /**
   * Optional callback invoked after the transaction begins but before
   * the user function runs. Useful for setting additional GUCs (e.g.
   * `app.user_id`) in the same transaction scope.
   */
  setup?: (tx: SchoolContextTx) => Promise<void>;
}

/**
 * Run `fn` inside a transaction with `app.school_id` set to `schoolId`.
 *
 * Throws if `schoolId` is not a valid UUID — better to fail fast than to
 * silently run a tenant query with a null `app.school_id` (which would
 * return zero rows from every RLS-protected table and look like a
 * "no results" bug downstream).
 */
export async function withSchoolContext<T>(
  db: Db,
  schoolId: string,
  fn: (tx: SchoolContextTx) => Promise<T>,
  options: WithSchoolContextOptions = {},
): Promise<T> {
  assertUuid(schoolId, 'withSchoolContext: schoolId');
  return db.transaction(async (tx) => {
    // set_config(name, value, is_local=true) is the parameterized form
    // of SET LOCAL. The value is bound to this transaction and discarded
    // at COMMIT/ROLLBACK.
    await tx.execute(
      sql`SELECT set_config('app.school_id', ${schoolId}, true)`,
    );
    if (options.setup) {
      await options.setup(tx as unknown as SchoolContextTx);
    }
    return fn(tx as unknown as SchoolContextTx);
  });
}

/**
 * Same as `withSchoolContext` but with `app.user_id` also set. Use this
 * in handlers that have an authenticated user; the audit log writer
 * reads `app.user_id` so the audit row is correctly attributed.
 */
export async function withUserContext<T>(
  db: Db,
  schoolId: string,
  userId: string,
  fn: (tx: SchoolContextTx) => Promise<T>,
  options: Omit<WithSchoolContextOptions, 'setup'> = {},
): Promise<T> {
  assertUuid(schoolId, 'withUserContext: schoolId');
  assertUuid(userId, 'withUserContext: userId');
  return withSchoolContext(
    db,
    schoolId,
    fn,
    {
      ...options,
      setup: async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.user_id', ${userId}, true)`,
        );
      },
    },
  );
}

/**
 * Standalone helper: set `app.school_id` on a transaction that was
 * opened elsewhere. Most callers should use `withSchoolContext` instead;
 * this is exposed for the rare case where the caller needs to compose
 * the transaction with other state (e.g. a wrapper that opens a tx
 * across multiple school contexts).
 */
export async function setSchoolContext(
  tx: SchoolContextTx,
  schoolId: string,
): Promise<void> {
  assertUuid(schoolId, 'setSchoolContext: schoolId');
  await tx.execute(
    sql`SELECT set_config('app.school_id', ${schoolId}, true)`,
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID (got ${JSON.stringify(value)})`);
  }
}

// Re-export `sql` for downstream callers that want to build queries
// without importing drizzle-orm directly. Avoids forcing every consumer
// to add drizzle-orm as a direct dependency.
export { sql };
