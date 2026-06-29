// apps/web/app/routes/login.tsx
//
// Email + password sign-in. Per spec section 5:
//   - bcrypt-hashed passwords (12 rounds, see auth.server.ts#hashPassword)
//   - 30-day rolling session cookie (`edusupervise.session`, HMAC-signed)
//   - HttpOnly, SameSite=Lax, Path=/; Secure in prod
//   - Cookie name spec'd as `__Host-edusupervise.session` for prod; we
//     ship the unprefixed form in dev so the cookie survives http://
//     localhost (the `__Host-` prefix REQUIRES Secure which http://
//     can't satisfy).
//
// CSRF: validateCsrf rejects cross-origin + token-mismatch mutations.
// Rate-limit: 5 attempts / 15 min / IP (checkLoginByIp).
//
// The user lookup needs the system role (BYPASSRLS) because at sign-in
// time we don't yet know the user's school — the runtime role's
// RLS-bound `users` query would return zero rows.
import { Form, redirect, useActionData } from 'react-router';
import type { Route } from './+types/login';
import { eq, and } from 'drizzle-orm';
import { getSystemClient, users } from '@edusupervise/db';
import {
  verifyPassword,
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server';
import { validateCsrf } from '../../server/csrf.server';
import { checkLoginByIp } from '../../server/rate-limit.server';

export function meta() {
  return [{ title: 'Sign in — EduSupervise' }];
}

export async function loader() {
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  // CSRF first — cheapest rejection of cross-origin POSTs.
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  // Rate-limit by client IP. We honour X-Forwarded-For so the limit
  // keys off the real client behind a reverse proxy.
  const ip = readClientIp(request);
  const rate = checkLoginByIp(ip);
  if (!rate.ok) {
    return Response.json(
      { error: 'rate_limited', detail: 'Too many login attempts. Try again in a few minutes.' },
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(rate.retryAfterSec),
        },
      },
    );
  }

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  if (!email || !password) {
    return Response.json({ error: 'missing_credentials' }, { status: 400 });
  }

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return Response.json(
      { error: 'server_misconfigured' },
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  const { db, close } = getSystemClient(systemUrl);
  try {
    const rows = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.email, email), eq(users.isActive, true)))
      .limit(1);
    const user = rows[0];
    if (!user || !user.passwordHash) {
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    const { token } = newSessionTokenFor(user.id);
    return redirect('/app', {
      headers: {
        'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}`,
      },
    });
  } finally {
    await close();
  }
}

export default function LoginPage() {
  const data = useActionData() as { error?: string } | undefined;
  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Welcome back</h1>
        <p className="text-sm text-slate-600 mb-6">Sign in to EduSupervise.</p>
        <Form method="post" className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input name="email" type="email" required autoComplete="email"
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input name="password" type="password" required autoComplete="current-password"
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none" />
          </label>
          {data?.error && <p className="text-sm text-red-600" role="alert">Invalid email or password.</p>}
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
            Sign in
          </button>
        </Form>
        <p className="text-sm text-slate-600 text-center mt-6">
          New school? <a href="/signup" className="text-blue-600 hover:underline">Create one</a>
          {' · '}
          <a href="/forgot" className="text-blue-600 hover:underline">Forgot password?</a>
          {' · '}
          <a href="/auth/magic" className="text-blue-600 hover:underline">Email me a link</a>
        </p>
      </div>
    </main>
  );
}

function readClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}