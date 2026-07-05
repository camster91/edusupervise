// apps/web/app/routes/api.signup.solo.ts
//
// POST /api/signup/solo — Create a brand-new school with the user as
// the only `school_admin`. Public endpoint. CSRF-protected.
// Rate-limited (5/email/hr, 20/IP/hr).
//
// On success: issues a session cookie and redirects to /onboarding/admin.

import { redirect } from 'react-router';
import type { Route } from './+types/api.signup.solo';
import { validateCsrfWithFormToken } from '../../server/csrf.server';
import { clientIp as readClientIp } from '../../server/client-ip.server';
import {
  signupSolo,
  parseSoloRole,
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
  const schoolName = String(form.get('schoolName') ?? '').trim();
  // Phase 1.1: solo signups now pick a role at /signup (default Teacher).
  // Invalid strings silently fall back to school_admin (see signupSolo).
  const role = parseSoloRole(form.get('role'));

  if (!name || !email || !password || !schoolName) {
    return Response.json(
      { error: 'All fields are required.' },
      { status: 400 },
    );
  }

  const result = await signupSolo(
    { mode: 'solo', name, email, password, schoolName, role: role ?? undefined } satisfies SoloSignupInput,
    { ipAddress: readClientIp(request), userAgent: clientUa(request) },
  );

  if (!result.ok || !result.userId) {
    const status =
      result.code === 'rate_limited' ? 429
      : result.code === 'duplicate_email' ? 409
      : 400;
    return Response.json({ error: result.error ?? 'Signup failed.' }, { status });
  }

  const { token } = newSessionTokenFor(result.userId);
  logger.info(
    { userId: result.userId, mode: 'solo', role: result.role },
    'signup.solo: success',
  );

  // Phase 1.1: route to the right onboarding wizard based on the user's
  // chosen role. Teacher + EA share /onboarding/solo (the same wizard);
  // school_admin keeps /onboarding/admin.
  const onboardingPath =
    result.role === 'school_admin'
      ? '/onboarding/admin'
      : '/onboarding/solo';

  return redirect(onboardingPath, {
    headers: {
      'Set-Cookie': `edusupervise.session=${token}; ${sessionCookieAttributes()}`,
    },
  });
}