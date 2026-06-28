// apps/web/app/routes/login.tsx — /login (UI).
//
// Renders a login form that POSTs to /auth/login. The form includes a
// hidden `_csrf` input that the action validates against the
// `__Host-edusupervise.csrf` cookie.
//
// The route loader mints a CSRF token if the cookie is missing, so the
// first navigation lands on a usable form.
//
// Magic link: separate form below the password form, posts to
// /auth/magic (request) — the response includes the URL the user
// should email themselves; for production the email adapter sends the
// link. We don't implement that here.
//
// OAuth buttons (Google, Microsoft) are stubs — they hit
// /api/auth/sign-in/social/:provider which better-auth handles.

import { redirect } from 'react-router';

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';
import { getSession } from '~/server/auth.server';

import type { Route } from './+types/login';

export async function loader({ request }: Route.LoaderArgs) {
  // If already signed in, redirect to /app.
  const session = await getSession(request);
  if (session) return redirect('/app');

  // Prime the CSRF cookie if missing.
  const cookieHeader = request.headers.get('cookie') ?? '';
  const hasCsrf = cookieHeader.split(';').some((p) => p.trim().startsWith(`${CSRF_COOKIE_NAME}=`));
  const headers = new Headers();
  let csrf = '';
  if (!hasCsrf) {
    csrf = generateCsrfToken();
    headers.append('set-cookie', buildCsrfSetCookie(csrf));
  } else {
    // Pull the existing token out so the form can re-embed it.
    for (const p of cookieHeader.split(';')) {
      const [name, ...rest] = p.trim().split('=');
      if (name === CSRF_COOKIE_NAME) csrf = rest.join('=');
    }
  }
  return new Response(
    renderLoginPage(csrf),
    { headers: { ...Object.fromEntries(headers), 'content-type': 'text/html; charset=utf-8' } },
  );
}

function renderLoginPage(csrf: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — EduSupervise</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; }
    .divider { margin: 1.5rem 0; text-align: center; color: #888; font-size: 0.85rem; }
    .errors { color: #b00020; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Sign in</h1>
  <form method="post" action="/auth/login">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <label>Email
      <input type="email" name="email" required autocomplete="username" />
    </label>
    <label>Password
      <input type="password" name="password" required autocomplete="current-password" />
    </label>
    <button type="submit">Sign in</button>
  </form>
  <div class="divider">— or —</div>
  <form method="post" action="/api/auth/sign-in/magic-link">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <label>Magic link email
      <input type="email" name="email" required autocomplete="username" />
    </label>
    <button type="submit">Send magic link</button>
  </form>
  <p><a href="/forgot">Forgot password?</a> · <a href="/signup">Create a school</a></p>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}