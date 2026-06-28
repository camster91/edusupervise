// apps/web/server/csrf.server.ts
//
// CSRF double-submit cookie pattern. The cookie is read by JS and attached
// to mutation requests via the x-csrf-token header. Server compares with
// crypto.timingSafeEqual. Validity derives from session lifetime — there is
// NO server-side timestamp; tokens are stateless.

import { timingSafeEqual } from 'node:crypto';
import { createHmac } from 'node:crypto';

const CSRF_COOKIE = 'edusupervise.csrf';

function getSecret(): string {
  const secret = process.env.SESSION_SECRET ?? 'dev-only-csrf-secret';
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', getSecret()).update(value).digest('base64url');
}

/** Issue a fresh CSRF token and the Set-Cookie attribute for first-GET. */
export function csrfCookie(): { token: string; setCookie: string } {
  const raw = crypto.randomUUID();
  const token = `${raw}.${sign(raw)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const setCookie = `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=86400${secure}`;
  return { token, setCookie };
}

/** Validate the header vs the cookie. Returns true on match, false otherwise. */
export function validateCsrf(request: Request): boolean {
  const header = request.headers.get('x-csrf-token');
  if (!header) return false;
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return false;
  let cookieToken: string | null = null;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    if (pair.slice(0, idx).trim() === CSRF_COOKIE) {
      cookieToken = pair.slice(idx + 1).trim();
      break;
    }
  }
  if (!cookieToken) return false;
  if (header.length !== cookieToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(cookieToken));
  } catch {
    return false;
  }
}

export function csrfRequiredResponse(): Response {
  return new Response(JSON.stringify({ error: 'csrf_invalid' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}