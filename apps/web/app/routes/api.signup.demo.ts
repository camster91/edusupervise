// apps/web/app/routes/api.signup.demo.ts
//
// POST /api/signup/demo — Create a pre-seeded 30-day demo school.
// Public endpoint. CSRF-protected. Rate-limited (5/email/hr, 20/IP/hr).
//
// On success: issues a session cookie and redirects to /app/today
// (skips onboarding wizard — the demo dataset is the orientation).

import { redirect } from 'react-router';
import type { Route } from './+types/api.signup.demo';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import { clientIp as readClientIp } from '../../server/client-ip.server';
import {
  signupDemo,
  type DemoSignupInput,
} from '../../server/signup.server';
import {
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  // GET on this POST-only endpoint — likely someone testing the URL in
  // a browser address bar. Redirect to /signup so the visit lands on
  // the actual signup page (where the form that posts here lives).
  return redirect('/signup');
}



function clientUa(request: Request): string | null {
  return request.headers.get('user-agent') ?? null;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');

  if (!name || !email || !password) {
    return Response.json(
      { error: 'All fields are required.' },
      { status: 400 },
    );
  }

  const result = await signupDemo(
    { mode: 'demo', name, email, password } satisfies DemoSignupInput,
    { ipAddress: readClientIp(request), userAgent: clientUa(request) },
  );

  if (!result.ok || !result.userId) {
    const status = result.code === 'rate_limited' ? 429 : 400;
    return Response.json({ error: result.error ?? 'Signup failed.' }, { status });
  }

  const { token } = newSessionTokenFor(result.userId);
  logger.info({ userId: result.userId, mode: 'demo' }, 'signup.demo: success');

  return redirect('/app/today', {
    headers: {
      'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}`,
    },
  });
}