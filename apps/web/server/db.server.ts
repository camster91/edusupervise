// apps/web/server/db.server.ts — runtime Drizzle client + per-request user /
// school helpers used by route loaders.
//
// Why this file:
//   - The existing foundation stub had `getDb` in `auth.server.ts` only.
//     Many routes need the same client + the same
//     `getCurrentUser(request)` / `getCurrentSchool(request)` pattern.
//     Putting them in `db.server.ts` makes the import surface uniform:
//     every route does `import { getDb, getCurrentUser } from '~/server/db.server'`
//     and never touches auth.server directly.
//   - The `withSchoolContext` re-export here is a convenience for routes
//     that want to compose their own transaction (e.g. an action that
//     reads + writes multiple tenant tables).
//
// RLS contract:
//   - Every helper in this file that returns a User or School row runs
//     inside `withUserContext` so the returned data is verified against
//     the school's RLS context.
//   - Loaders/actions that ONLY need (userId, schoolId, role) use the
//     lightweight `getSession` from auth.server (no DB round-trip on
//     hot paths) — the helpers here are for code paths that need the
//     full row.

import { eq } from 'drizzle-orm';

import {
  withSchoolContext,
  withUserContext,
  type SchoolContextTx,
} from '@edusupervise/db';

import {
  schools,
  users,
  type School,
  type User,
} from '@edusupervise/db';

import { getDb as getAuthDb } from './auth.server';
import type { Session } from './auth.server';

export { withSchoolContext, withUserContext };
export type { SchoolContextTx };

/** Re-export the runtime client getter so routes import a single file. */
export function getDb() {
  return getAuthDb();
}

/**
 * Load the full User row for the current request's session, inside an RLS
 * transaction. Returns null if the session is missing OR the user is
 * inactive OR the user no longer exists.
 *
 * Prefer `getSession()` (auth.server) for the common case where all you
 * need is `{ userId, schoolId, role, email, name }` — that path skips the
 * full row load.
 */
export async function getCurrentUser(session: Session | null): Promise<User | null> {
  if (!session) return null;
  return withUserContext(getDb(), session.schoolId, session.userId, async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Load the full School row for the current request's session, inside an
 * RLS transaction. Returns null if the session is missing OR the school
 * no longer exists.
 */
export async function getCurrentSchool(session: Session | null): Promise<School | null> {
  if (!session) return null;
  return withSchoolContext(getDb(), session.schoolId, async (tx) => {
    const rows = await tx
      .select()
      .from(schools)
      .where(eq(schools.id, session.schoolId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Load both the current user and the current school in a single
 * transaction. Useful for /app shell loaders that need both.
 */
export async function getCurrentUserAndSchool(
  session: Session | null,
): Promise<{ user: User; school: School } | null> {
  if (!session) return null;
  return withUserContext(getDb(), session.schoolId, session.userId, async (tx) => {
    const [userRows, schoolRows] = await Promise.all([
      tx.select().from(users).where(eq(users.id, session.userId)).limit(1),
      tx.select().from(schools).where(eq(schools.id, session.schoolId)).limit(1),
    ]);
    const user = userRows[0];
    const school = schoolRows[0];
    if (!user || !school) return null;
    return { user, school };
  });
}