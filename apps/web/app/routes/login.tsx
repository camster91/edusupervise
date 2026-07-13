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
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
} from 'react-router';
import type { Route } from './+types/login';
import { eq, and } from 'drizzle-orm';
import { getSystemClient, users } from '@edusupervise/db';
import {
  verifyPassword,
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server';
import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { checkLoginByIp } from '../../server/rate-limit.server';
import { clientIp as readClientIp } from '../../server/client-ip.server';

export function meta() {
  return [{ title: 'Sign in — EduSupervise' }];
}

/**
 * Loader returns the CSRF token so the form can include it in a
 * hidden field. Mints a new cookie + token if the request doesn't
 * already carry one — the form needs the real token to render on
 * first paint. See signup.tsx for the full pattern.
 */
export function loader({ request }: { request: Request }) {
  // ensureCsrfCookie reads the existing cookie or mints a fresh one
  // and returns the token + Set-Cookie header value. Using RR7's
  // data() wrapper keeps the loader-data shape consistent across
  // visits (previously returned plain object when cookie present,
  // Response-with-Set-Cookie when missing — triggered #418/#425).
  const { token, setCookie } = ensureCsrfCookie(request);
  const headers: HeadersInit | undefined = setCookie
    ? { 'Set-Cookie': setCookie }
    : undefined;
  return data({ csrfToken: token }, headers ? { headers } : undefined);
}

export async function action({ request }: Route.ActionArgs) {
  // Parse the form first so we can use validateCsrfWithFormToken
  // (which reads both cookie and form csrf field). The cookie-only
  // validateCsrf() doesn't work for browser form POSTs because the
  // `__Host-` cookie is HttpOnly in Chromium (verifier finding
  // 2026-06-30, B1).
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;

  // Rate-limit by client IP. We honour X-Forwarded-For so the limit
  // keys off the real client behind a reverse proxy.
  const ip = readClientIp(request);  // safe: only honours XFF when TRUST_PROXY=1
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
  const { csrfToken } = useLoaderData<typeof loader>();
  return (
    <main className="min-h-screen grid place-items-center bg-bg px-4">
      <div className="w-full max-w-sm bg-surface rounded-lg shadow-elev-1 border border-border p-8">
        <h1 className="text-title-1 font-bold text-primary mb-1">Welcome back</h1>
        <p className="text-sm text-secondary mb-6">Sign in to EduSupervise.</p>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="csrf" value={csrfToken} />
          <label className="block">
            <span className="text-sm font-medium text-primary">Email</span>
            <input name="email" type="email" required autoComplete="email"
              className="mt-1 block w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm focus:border-accent focus:ring-2 focus:ring-accent outline-none" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-primary">Password</span>
            <input name="password" type="password" required autoComplete="current-password"
              className="mt-1 block w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm focus:border-accent focus:ring-2 focus:ring-accent outline-none" />
          </label>
          {data?.error && <p className="text-sm text-error" role="alert">Invalid email or password.</p>}
          <button type="submit" className="w-full bg-accent hover:bg-accent-hover text-on-accent font-medium py-2 px-4 rounded-lg transition-colors">
            Sign in
          </button>
        </Form>
        <p className="text-sm text-secondary text-center mt-6">
          New school? <a href="/signup" className="text-accent hover:underline">Create one</a>
          {' · '}
          <a href="/forgot" className="text-accent hover:underline">Forgot password?</a>
          {' · '}
          <a href="/auth/magic" className="text-accent hover:underline">Email me a link</a>
        </p>
      </div>
    </main>
  );
}

