// apps/web/app/routes/api.signup.solo.ts
//
// POST /api/signup/solo — Create a brand-new school with the user as
// the only `school_admin`. Public endpoint. CSRF-protected.
// Rate-limited (5/email/hr, 20/IP/hr).
//
// On success: issues a session cookie and redirects to /onboarding/admin.

import { redirect } from 'react-router';
import type { Route } from './+types/api.signup.solo';
import { validateCsrf } from '../../server/csrf.server';
import {
  signupSolo,
  type SoloSignupInput,
} from '../../server/signup.server';
import {
  newSessionTokenFor,
  sessionCookieAttributes,
} from '../../server/auth.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  // GET on this POST-only endpoint — redirect to /signup.
  return redirect('/signup');
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
  const schoolName = String(form.get('schoolName') ?? '').trim();

  if (!name || !email || !password || !schoolName) {
    return Response.json(
      { error: 'All fields are required.' },
      { status: 400 },
    );
  }

  const result = await signupSolo(
    { mode: 'solo', name, email, password, schoolName } satisfies SoloSignupInput,
    { ipAddress: clientIp(request), userAgent: clientUa(request) },
  );

  if (!result.ok || !result.userId) {
    const status =
      result.code === 'rate_limited' ? 429
      : result.code === 'duplicate_email' ? 409
      : 400;
    return Response.json({ error: result.error ?? 'Signup failed.' }, { status });
  }

  const { token } = newSessionTokenFor(result.userId);
  logger.info({ userId: result.userId, mode: 'solo' }, 'signup.solo: success');

  return redirect('/onboarding/admin', {
    headers: {
      'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}`,
    },
  });
}