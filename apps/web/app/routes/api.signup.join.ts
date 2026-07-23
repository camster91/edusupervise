// apps/web/app/routes/api.signup.join.ts
//
// POST /api/signup/join — Join an existing school by `schoolCode`.
// Public endpoint. CSRF-protected. Rate-limited (5/email/hr, 20/IP/hr).
//
// On success: issues a session cookie and redirects to /onboarding/teacher.

import { redirect } from 'react-router';
import type { Route } from './+types/api.signup.join';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import { clientIp as readClientIp } from '../../server/client-ip.server';
import {
  signupJoin,
  type JoinSignupInput,
} from '../../server/signup.server';
import {
  newSessionTokenFor,
  setSessionCookie,
} from '../../server/auth.server';
import { logger } from '../../server/logger.server';

export async function loader() {
  // GET on this POST-only endpoint — likely someone testing the URL.
  // Redirect to /signup so the visit lands on the actual form.
  return redirect('/signup');
}



function clientUa(request: Request): string | null {
  return request.headers.get('user-agent') ?? null;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Content-Type gate: form-encoded only. JSON bodies must use the
  // x-csrf-token header path, not the form-body field. Returning 415
  // (not 500) avoids leaking internal error details to curl probes.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')
      && !contentType.toLowerCase().includes('multipart/form-data')) {
    return Response.json(
      { error: 'unsupported_media_type', detail: 'Use form-encoded body or x-csrf-token header.' },
      { status: 415 },
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: 'malformed_form_body' },
      { status: 400 },
    );
  }
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
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
    { ipAddress: readClientIp(request), userAgent: clientUa(request) },
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
      'Set-Cookie': setSessionCookie(token),
    },
  });
}