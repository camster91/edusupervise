// apps/web/app/routes/forgot.tsx — /forgot (UI).
//
// Renders a single email field; POSTs to /auth/forgot.

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';

import type { Route } from './+types/forgot';

export async function loader({ request }: Route.LoaderArgs) {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const hasCsrf = cookieHeader.split(';').some((p) => p.trim().startsWith(`${CSRF_COOKIE_NAME}=`));
  const headers = new Headers();
  let csrf = '';
  if (!hasCsrf) {
    csrf = generateCsrfToken();
    headers.append('set-cookie', buildCsrfSetCookie(csrf));
  } else {
    for (const p of cookieHeader.split(';')) {
      const [name, ...rest] = p.trim().split('=');
      if (name === CSRF_COOKIE_NAME) csrf = rest.join('=');
    }
  }
  return new Response(render(csrf), {
    headers: { ...Object.fromEntries(headers), 'content-type': 'text/html; charset=utf-8' },
  });
}

function render(csrf: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Forgot password — EduSupervise</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; }
    .honeypot { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  </style>
</head>
<body>
  <h1>Forgot password</h1>
  <p>Enter your email — we'll send a reset link if the account exists.</p>
  <form method="post" action="/auth/forgot">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <div class="honeypot"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>
    <label>Email<input type="email" name="email" required autocomplete="username" /></label>
    <button type="submit">Send reset link</button>
  </form>
  <p><a href="/login">Back to sign in</a></p>
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