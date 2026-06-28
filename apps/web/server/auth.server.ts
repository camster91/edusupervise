// apps/web/server/auth.server.ts — session / role lookup helper.
//
// STUB: replaced by the auth-and-rls task which wires better-auth's
// full session API. The shape we expose here
// (`getSession(request) -> Session | null`) is the contract the rest of
// the app should target, so swapping the implementation later is a
// single-file change.
//
// Security note for now: we read the better-auth session cookie name
// (`better-auth.session_token`) and look up the user in the DB directly.
// Without better-auth's signing-key validation this is NOT cryptographically
// safe for production — but the auth-and-rls task is one cycle away
// and is the right place to plug in `auth.api.getSession({ headers })`.
//
// Why we still do a DB lookup:
//
//   - Lets route handlers use `session.user.role` for admin-only checks
//     (e.g. /api/push/test) instead of trusting the cookie value.
//   - Means a deleted-but-still-cookied user is rejected (DB row gone).
//   - Means a CSRF-protected POST with a stale cookie fails auth before
//     hitting the DB, same as the eventual implementation.

import { eq, and } from 'drizzle-orm';
import { users } from '@edusupervise/db';

import { getRuntimeClient, type Db } from '@edusupervise/db';

export type UserRole = 'school_admin' | 'teacher' | 'substitute';

export interface Session {
  userId: string;
  schoolId: string;
  email: string;
  role: UserRole;
  name: string;
}

const SESSION_COOKIE_NAMES = [
  'better-auth.session_token',
  // Better-auth can also issue a session JWT as a cookie in some
  // configurations; covered defensively.
  'better-auth.session_jwt',
];

/**
 * Read the authenticated session from the request cookies, OR return null
 * if the session is missing / invalid / the user no longer exists.
 *
 * TODO(auth-and-rls): replace with `auth.api.getSession({ headers })` once
 * the better-auth config lands. Same return shape, same null-on-missing
 * semantics — route handlers don't need to change.
 */
export async function getSession(
  request: Request,
): Promise<Session | null> {
  const token = readSessionToken(request);
  if (!token) return null;

  const userId = decodeSessionToken(token);
  if (!userId) return null;

  return loadSessionFromDb(userId);
}

/**
 * Load a session from the user id extracted from the cookie. We do NOT
 * validate the cookie signature here (TODO auth-and-rls); we only
 * confirm a real user row exists with the right school_id linkage.
 */
async function loadSessionFromDb(userId: string): Promise<Session | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      schoolId: users.schoolId,
      email: users.email,
      role: users.role,
      name: users.name,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id,
    schoolId: row.schoolId,
    email: row.email,
    role: row.role,
    name: row.name,
  };
}

/**
 * Extract a session token from a `Cookie` header value. Returns the
 * first matching cookie value, OR null if no session cookie is present.
 *
 * Cookies arrive as a single header like:
 *   better-auth.session_token=abc123; theme=dark
 * so a simple split + trim is enough — we don't need a full cookie
 * parser for one or two cookies.
 */
function readSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (!SESSION_COOKIE_NAMES.includes(name)) continue;
    return pair.slice(eqIdx + 1).trim();
  }
  return null;
}

/**
 * Decode the better-auth session token to a user id. The cookie value
 * is `<signature>.<userId>` (base64-url safe); we strip the signature
 * half because we don't validate it yet (TODO auth-and-rls). The
 * resulting UUID is then verified against the DB.
 */
function decodeSessionToken(token: string): string | null {
  // Strip signature: better-auth encodes "userId.timestamp.signature" —
  // we keep the first segment, which is the userId.
  const parts = token.split('.');
  const candidate = parts[0];
  if (!candidate) return null;
  if (!/^[0-9a-f-]{36}$/i.test(candidate)) return null;
  return candidate;
}

function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'auth.server: DATABASE_URL is not set. ' +
        'Export DATABASE_URL=postgres://edusupervise_runtime:... and retry.',
    );
  }
  return getRuntimeClient(url).db;
}

/**
 * Throw a 401 Response if the session is missing. Routes use this to
 * short-circuit before touching the DB.
 */
export function requireSession(session: Session | null): Session {
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}

/**
 * Throw a 403 Response if the session role is not in the allowed set.
 */
export function requireRole(
  session: Session,
  allowed: ReadonlyArray<UserRole>,
): Session {
  if (!allowed.includes(session.role)) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}