// app/routes/auth.logout.tsx — sign-out endpoint.
//
// Logout is POST-only (per spec section 5 — logout is a state-changing
// operation). The action:
//   1. Validates CSRF
//   2. Calls better-auth's signOut API (deletes session row + clears cookie)
//   3. Redirects to /login with the cleared Set-Cookie headers

import { redirect, type ActionFunctionArgs } from 'react-router';

import { getAuth } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const auth = getAuth();
  try {
    const result = await auth.api.signOut({
      headers: request.headers,
      asResponse: true,
      returnHeaders: true,
    });

    const headers = new Headers({ Location: '/login' });
    const setCookies = result.headers.getSetCookie();
    for (const c of setCookies) headers.append('Set-Cookie', c);
    await result.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 303, headers });
  } catch (err) {
    // Even if signOut fails, redirect to /login (the client cookie
    // will be cleared by the browser on the next session read).
    return redirect('/login');
  }
}