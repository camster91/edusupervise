// apps/web/app/routes/auth.reset.tsx — POST /auth/reset.
//
// Consumes a password-reset token. Per spec section 5 the token is sent
// in the BODY (POST { token, newPassword }), not via GET URL — this
// avoids leaking the token in the browser history / Referer header.

import { redirect } from 'react-router';

import { resetSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import { validateCsrfFromForm } from '~/server/csrf.server';

import type { Route } from './+types/auth.reset';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const raw = Object.fromEntries(formData);
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_input',
        issues: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const result = await getAuth().api.resetPassword({
    body: {
      token: parsed.data.token,
      newPassword: parsed.data.newPassword,
    },
    asResponse: true,
    headers: request.headers,
  });

  // On success, better-auth auto-signs the user in and returns the
  // session cookie. Forward everything.
  if (result.ok) {
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

  // On failure, surface better-auth's body so the client can show the
  // error.
  const body = await result.clone().text().catch(() => '');
  return new Response(body, {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/reset');
}