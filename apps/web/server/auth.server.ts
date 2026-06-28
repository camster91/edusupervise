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

import { eq, and } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { users } from '@edusupervise/db';

export type UserRole = 'school_admin' | 'teacher' | 'substitute';

export interface Session {
  userId: string;
  schoolId: string;
  email: string;
  role: UserRole;
  name: string;
}

const SESSION_COOKIE = 'edusupervise.session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

export function sessionCookieAttributes(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export async function getSession(request: Request): Promise<Session | null> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
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
  const { getDb } = await import('./db.server');
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