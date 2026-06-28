// apps/web/app/routes/auth.forgot.tsx — POST /auth/forgot.
//
// Requests a password-reset link. better-auth's `forgetPassword` API
// mints a one-time token, stores it in auth_verification, and (per our
// config) calls the emailAndPassword.sendResetPassword callback with the
// URL — that callback writes to console.warn for now; the email adapter
// is wired in the email package.
//
// Rate limit: 3 / hour / email (spec section 5).
// Honeypot: same as signup — bots fill `website`, humans don't see it.

import { redirect } from 'react-router';

import { forgotSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import { validateCsrfFromForm } from '~/server/csrf.server';
import {
  buildRateLimitedResponse,
  consume,
  RATE_LIMITS,
} from '~/server/rate-limit.server';

import type { Route } from './+types/auth.forgot';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const raw = Object.fromEntries(formData);
  const parsed = forgotSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input' },
      { status: 400 },
    );
  }

  // Honeypot — silently succeed.
  if (parsed.data.website && parsed.data.website.length > 0) {
    return Response.json({ ok: true });
  }

  // Rate limit by email (not IP — same email from different IPs is the
  // attack we care about).
  const rl = consume('forgot', parsed.data.email, RATE_LIMITS.forgot);
  if (!rl.allowed) return buildRateLimitedResponse(rl);

  // Always 200, even if no user matches — to avoid leaking which emails
  // are registered. better-auth's API will no-op silently if the user
  // doesn't exist.
  await getAuth().api.forgetPassword({
    body: {
      email: parsed.data.email,
      redirectTo: '/reset',
    },
    headers: request.headers,
  });

  return Response.json({ ok: true });
}

export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/forgot');
}