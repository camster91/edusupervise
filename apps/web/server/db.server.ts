// apps/web/server/db.server.ts — RLS-aware Drizzle wrapper for the web app.
//
// Centralises three concerns for the request path:
//   1. The runtime-role Drizzle client (`getDb()`).
//   2. The canonical RLS-scoped read pattern: open a transaction with
//      `app.school_id` set from the authenticated session (`withSchool`,
//      `withUser`).
//   3. Loaders' helpers that combine a session lookup with an RLS-aware
//      read (`getCurrentUser`, `getCurrentSchool`).
//
// Why a single module owns this:
//   - The runtime role does NOT own tables; without `FORCE RLS` + an
//     `app.school_id` set in EVERY transaction, every query returns zero
//     rows. A loader that forgets the wrapper looks like "no results"
//     downstream — silent failure mode that's hard to debug.
//   - The wrapper is the ONE place where we (a) read DATABASE_URL,
//     (b) instantiate the postgres.js connection pool, and (c) hand off
//     to `withSchoolContext` / `withUserContext`. Routes never reach
//     into the client directly.
//   - Multi-tenancy is the contract that protects every customer from
//     every other. Funneling all reads through this module is the
//     cheap, enforceable way to keep the contract.

import { eq } from 'drizzle-orm';
import {
  getRuntimeClient,
  schools,
  users,
  withSchoolContext,
  withUserContext,
  type Db,
  type SchoolContextTx,
} from '@edusupervise/db';

import { getSession, type AppSession } from './auth.server';

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Lazily-built runtime Drizzle client. One per Node process; the pool is
 * drained on container shutdown via the SIGTERM handler in the entry
 * server. We hold a single client because the runtime role has a low
 * connection limit (max_connections=100 in the 8GB tuning) and 10
 * connections per web container is plenty for ~100 RPS.
 */
let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'db.server: DATABASE_URL is not set. ' +
        'Export DATABASE_URL=postgres://edusupervise_runtime:... and retry.',
    );
  }
  _db = getRuntimeClient(url).db;
  return _db;
}

/**
 * Test seam: inject a pre-built Drizzle client. Used by the integration
 * test harness so tests don't depend on the env var resolution.
 */
export function setDb(db: Db): void {
  _db = db;
}

/** Drop the cached client (test cleanup). */
export function closeDb(): Promise<void> | void {
  // We don't have a handle to the postgres.js client here; getRuntimeClient
  // builds it and hands back just the drizzle wrapper. Tests that need
  // to drain the pool should call this and then call setDb(null) at the
  // end of the run. For now, simply null out the cache so the next
  // getDb() call builds a fresh pool.
  _db = null;
}

// ---------------------------------------------------------------------------
// Scoped transactions
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a transaction with `app.school_id` set to the
 * authenticated session's school. Use this in route loaders / actions
 * that already have a session and need to read tenant data.
 *
 * Throws 401 if there is no session. The schoolId is sourced from the
 * session (which came from better-auth → users.school_id) — NEVER from
 * the URL or request body, which would let an attacker pivot to another
 * tenant by changing the path.
 */
export async function withSchool<T>(
  request: Request,
  fn: (tx: SchoolContextTx, session: AppSession) => Promise<T>,
): Promise<T> {
  const session = await getSession(request);
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const db = getDb();
  return withSchoolContext(db, session.schoolId, (tx) => fn(tx, session));
}

/**
 * Same as `withSchool` but also sets `app.user_id` for audit log
 * attribution. Use this for state-changing actions so the `audit_log`
 * row written inside the transaction is correctly attributed to the
 * authenticated user.
 */
export async function withUser<T>(
  request: Request,
  fn: (tx: SchoolContextTx, session: AppSession) => Promise<T>,
): Promise<T> {
  const session = await getSession(request);
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const db = getDb();
  return withUserContext(db, session.schoolId, session.userId, (tx) =>
    fn(tx, session),
  );
}

// ---------------------------------------------------------------------------
// Loader helpers
// ---------------------------------------------------------------------------

/**
 * Look up the authenticated user row inside the school context. Returns
 * null when:
 *   - the session is missing (caller should redirect to /login)
 *   - the user row was deleted after the session was issued
 *   - RLS rejected the read (defense-in-depth — the session's school_id
 *     and the user's actual school_id diverge somehow)
 */
export async function getCurrentUser(
  request: Request,
): Promise<(typeof users.$inferSelect) | null> {
  const session = await getSession(request);
  if (!session) return null;
  const db = getDb();
  return withSchoolContext(db, session.schoolId, async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Look up the authenticated user's school row. RLS-protected — a user
 * can only ever see their own school's row, regardless of what they put
 * in the URL.
 */
export async function getCurrentSchool(
  request: Request,
): Promise<(typeof schools.$inferSelect) | null> {
  const session = await getSession(request);
  if (!session) return null;
  const db = getDb();
  return withSchoolContext(db, session.schoolId, async (tx) => {
    const rows = await tx
      .select()
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Convenience: look up session + user + school in one call. Loaders
 * typically need all three; this saves two extra session lookups.
 *
 * Returns `null` (with no throw) when the session is missing — the caller
 * is responsible for redirecting to /login. Returns a 404-ish shape
 * (user null or school null) when the data is gone, so the loader can
 * render a "session expired" page rather than 500-ing.
 */
export async function getCurrentContext(
  request: Request,
): Promise<{
  session: AppSession;
  user: typeof users.$inferSelect;
  school: typeof schools.$inferSelect;
} | null> {
  const session = await getSession(request);
  if (!session) return null;
  const db = getDb();
  return withSchoolContext(db, session.schoolId, async (tx) => {
    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const schoolRows = await tx
      .select()
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    const user = userRows[0];
    const school = schoolRows[0];
    if (!user || !school) return null;
    return { session, user, school };
  });
}