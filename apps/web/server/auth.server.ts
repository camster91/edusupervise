// apps/web/server/auth.server.ts
//
// Minimal auth implementation for Tier 1. Uses bcrypt for password hashing
// and HMAC-signed session cookies. Real better-auth integration is the
// Tier 1.5 upgrade per spec section 5; this file is a single-file swap to
// upgrade (the Session contract is unchanged).
//
// Session cookie: `edusupervise.session` = base64url(payload).signature
// where payload = `${userId}|${expiresAt}` and signature =
// HMAC-SHA256(SESSION_SECRET, payload). Validation uses timingSafeEqual.
//
// Production hardening (audit 2026-07-21):
//   - Cookie name is env-aware. In production we use the `__Host-` prefix
//     which the browser requires to set Secure + Path=/ + no Domain. In
//     dev we keep the bare name so http://localhost continues to work
//     (the `__Host-` prefix REQUIRES Secure which http:// can't satisfy).
//   - Both env values are exported as SESSION_COOKIE_NAME so routes that
//     emit a Set-Cookie header can reference the same constant (and
//     therefore stay in sync if the env rule changes again).
//   - sessionCookieAttributes() now also emits `Secure` and `__Host-` in
//     prod, and `setSessionCookie(token)` is a one-shot helper that
//     builds the full Set-Cookie header (name + value + attrs). Routes
//     that still build the header by hand should migrate to it.
//
// `__Host-` requirements (browsers reject if any are missing):
//   - Secure attribute (HTTPS-only)
//   - Path=/
//   - No Domain attribute (host-locked)

import { eq, and } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { users } from '@edusupervise/db';
import { getSystemDb } from './db.server';
import type { UserRole } from '@edusupervise/db';
// Re-export so shell/* components can keep importing the Session's role type.
export type { UserRole };


export interface Session {
  userId: string;
  schoolId: string;
  email: string;
  role: UserRole;
  name: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Cookie name (env-aware).
 *
 * Production: `__Host-edusupervise.session` — the `__Host-` prefix
 * instructs the browser to enforce Secure + Path=/ + no Domain on the
 * cookie, hardening it against subdomain-takeover attacks that could
 * otherwise write a sibling subdomain's cookie.
 *
 * Dev/test: `edusupervise.session` — the prefix is dropped because the
 * browser requires Secure (https://) for `__Host-` cookies and dev runs
 * on http://localhost. The bare name is host-locked by virtue of no
 * Domain attribute being set, which is the same security boundary in
 * dev (no subdomains on localhost).
 *
 * Routes that emit a Set-Cookie header for the session MUST reference
 * this constant — never hardcode `edusupervise.session` directly.
 */
export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === 'production'
    ? '__Host-edusupervise.session'
    : 'edusupervise.session';

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function verify(payload: string, signature: string): boolean {
  const expected = sign(payload);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function encodeSessionToken(userId: string, expiresAt: number): string {
  const payload = `${userId}|${expiresAt}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function decodeSessionToken(token: string): { userId: string; expiresAt: number } | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!verify(payload, token.slice(dot + 1))) return null;
  const [userId, expiresAtStr] = payload.split('|');
  if (!userId || !expiresAtStr) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { userId, expiresAt };
}

/**
 * Cookie attribute string (no cookie name).
 *
 * Returns the cookie attributes that go AFTER the name=value pair in a
 * Set-Cookie header. Routes that build the header by hand
 * (`Set-Cookie: ${NAME}=${TOKEN}; ${sessionCookieAttributes()}`) can
 * keep their structure; new code should prefer `setSessionCookie(token)`.
 *
 * In production: `Secure` is added (required for `__Host-`) and the
 * resulting attribute set satisfies the `__Host-` prefix contract:
 *   Secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=...
 *
 * In dev: `Secure` is omitted (http://localhost would reject the cookie
 * otherwise). The bare cookie name in dev still has no Domain attribute
 * so it is host-locked.
 */
export function sessionCookieAttributes(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

/**
 * Build a full Set-Cookie header for the session.
 *
 * Returns a string of the form
 *   `${SESSION_COOKIE_NAME}=${token}; ${sessionCookieAttributes()}`
 *
 * Routes should set this verbatim in their response headers:
 *
 *   return redirect('/app', {
 *     headers: { 'Set-Cookie': setSessionCookie(token) },
 *   });
 *
 * Centralising the name + attributes here means every route emits the
 * same header, including the `__Host-` prefix in production. This is
 * the canonical fix for the audit finding "session cookie lacks __Host
 * in production" — callers that adopt this helper no longer have to
 * remember the prefix.
 */
export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${sessionCookieAttributes()}`;
}

/**
 * Build a Set-Cookie header that clears the session cookie.
 *
 * Emits Max-Age=0 (immediate expiry) against the env-aware cookie name,
 * so logout in production clears the `__Host-` cookie rather than the
 * bare dev cookie. Routes that previously hardcoded
 * `edusupervise.session=; ...; Max-Age=0` should migrate to this helper
 * for the same reasons as `setSessionCookie`.
 *
 * Note: browsers will not delete a `__Host-` cookie via a non-`__Host-`
 * Set-Cookie header, so the env-aware name matters for correctness of
 * the logout flow in prod.
 */
export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function getSession(request: Request): Promise<Session | null> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!token) return null;
  const decoded = decodeSessionToken(token);
  if (!decoded) return null;
  return loadSessionFromDb(decoded.userId);
}

function parseCookie(header: string, name: string): string | null {
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    if (pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

async function loadSessionFromDb(userId: string): Promise<Session | null> {
  // Use the system role (BYPASSRLS) for the user lookup. At session-
  // validate time we don't yet know the user's school, so the runtime
  // role's RLS policy on `users` (which requires
  // `school_id = current_school_id()`) would return zero rows.
  // See: devops-gotchas.md "Auth-server user lookup must use system role".
  //
  // QA-swarm finding (2026-07-05): the prior implementation called
  // getSystemClient(systemUrl) on EVERY session-validate, opening a
  // fresh postgres pool per request and immediately closing it.
  // Under 50 concurrent requests this saturated the 10-conn runtime
  // pool limit and put 10/10 conns into `idle in transaction` for
  // 12+ minutes. Fix: use the cached system-role singleton
  // getSystemDb() (same lazy-build pattern as getDb() for the
  // runtime role).
  const db = getSystemDb();
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

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function newSessionTokenFor(userId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return { token: encodeSessionToken(userId, expiresAt), expiresAt };
}

export function requireSession(session: Session | null): Session {
  if (!session) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}

export function requireRole(session: Session, allowed: ReadonlyArray<UserRole>): Session {
  if (!allowed.includes(session.role)) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return session;
}