// apps/web/app/routes/auth.magic.tsx — POST /auth/magic.
//
// Consumes a magic-link token. Per spec section 5 the token is in the
// BODY (POST { token }), not via GET URL. We call better-auth's
// magicLinkVerify API directly with the token.
//
// Rate limit: 5 / hour / email (spec section 5).

import { redirect } from 'react-router';

import { magicConsumeSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import {
  buildCsrfSetCookieSecure,
  generateCsrfToken,
  validateCsrfFromForm,
} from '~/server/csrf.server';

import type { Route } from './+types/auth.magic';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const raw = Object.fromEntries(formData);
  const parsed = magicConsumeSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input' },
      { status: 400 },
    );
  }

  const result = await getAuth().api.magicLinkVerify({
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

  // Success: better-auth has issued a session cookie. Forward it and
  // rotate CSRF.
  const newCsrf = generateCsrfToken();
  const headers = new Headers();
  headers.set('location', '/app');
  const setCookies =
    result.headers.getSetCookie?.() ??
    (result.headers.get('set-cookie')
      ? [result.headers.get('set-cookie')!]
      : []);
  for (const sc of setCookies) headers.append('set-cookie', sc);
  headers.append('set-cookie', buildCsrfSetCookieSecure(newCsrf));
  return new Response(null, { status: 303, headers });
}

export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/login');
}