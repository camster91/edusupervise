// apps/web/app/routes/auth.verify-email.tsx — POST /auth/verify-email.
//
// Consumes an email-verification token. Per spec section 5 the token is
// in the BODY (POST { token }), not via GET URL.

import { redirect } from 'react-router';

import { verifyEmailSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import { validateCsrfFromForm } from '~/server/csrf.server';

import type { Route } from './+types/auth.verify-email';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const raw = Object.fromEntries(formData);
  const parsed = verifyEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input' },
      { status: 400 },
    );
  }

  // better-auth's verifyEmail endpoint validates the token stored in
  // auth_verification, marks the user's email_verified_at, and (per
  // our config) calls emailVerification.afterEmailVerification if set.
  const result = await getAuth().api.verifyEmail({
    body: { token: parsed.data.token },
    asResponse: true,
    headers: request.headers,
  });

  if (!result.ok) {
    const body = await result.clone().text().catch(() => '');
    return new Response(body, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Success — redirect to /app (or wherever the user was heading).
  const headers = new Headers();
  headers.set('location', '/app');
  const setCookies =
    result.headers.getSetCookie?.() ??
    (result.headers.get('set-cookie')
      ? [result.headers.get('set-cookie')!]
      : []);
  for (const sc of setCookies) headers.append('set-cookie', sc);
  return new Response(null, { status: 303, headers });
}

export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/verify-email');
}