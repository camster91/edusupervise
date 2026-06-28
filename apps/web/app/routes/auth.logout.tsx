// apps/web/app/routes/auth.logout.tsx — POST /auth/logout.
//
// Calls better-auth's signOut, which invalidates the session row in
// auth_session and clears the session cookie. We also rotate the CSRF
// cookie so a logged-out tab can't reuse a stale token.

import { redirect } from 'react-router';

import { getAuth } from '~/server/auth.server';
import {
  buildCsrfSetCookieSecure,
  generateCsrfToken,
  validateCsrfFromForm,
} from '~/server/csrf.server';

import type { Route } from './+types/auth.logout';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const result = await getAuth().api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  const newCsrf = generateCsrfToken();
  const headers = new Headers();
  headers.set('location', '/login');
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