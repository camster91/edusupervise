// apps/web/app/routes/api.signup.join.ts
//
// POST /api/signup/join — Join an existing school by `schoolCode`.
// Public endpoint. CSRF-protected. Rate-limited (5/email/hr, 20/IP/hr).
//
// On success: issues a session cookie and redirects to /onboarding/teacher.

import { redirect } from 'react-router';
import type { Route } from './+types/api.signup.join';
import { validateCsrf } from '../../server/csrf.server';
import {
  signupJoin,
  type JoinSignupInput,
} from '../../server/signup.server';
import {
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  return new Response('Method Not Allowed', { status: 405 });
}

function clientIp(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  );
}

function clientUa(request: Request): string | null {
  return request.headers.get('user-agent') ?? null;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const schoolCode = String(form.get('schoolCode') ?? '').trim();

  if (!name || !email || !password || !schoolCode) {
    return Response.json(
      { error: 'All fields are required.' },
      { status: 400 },
    );
  }

  const result = await signupJoin(
    { mode: 'join', name, email, password, schoolCode } satisfies JoinSignupInput,
    { ipAddress: clientIp(request), userAgent: clientUa(request) },
  );

  if (!result.ok || !result.userId) {
    const status =
      result.code === 'rate_limited' ? 429
      : result.code === 'duplicate_email' ? 409
      : result.code === 'quota_full' ? 409
      : result.code === 'invalid_code' ? 400
      : 400;
    return Response.json({ error: result.error ?? 'Signup failed.' }, { status });
  }

  const { token } = newSessionTokenFor(result.userId);
  logger.info({ userId: result.userId, mode: 'join' }, 'signup.join: success');

  return redirect('/onboarding/teacher', {
    headers: {
      'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}`,
    },
  });
}