// apps/web/app/routes/reset.tsx — /reset (UI).
//
// Renders the reset form. The token comes from the URL query string
// (the user clicked the link in their email). On submit, the token is
// POSTed in the body to /auth/reset — never re-exposed in the URL.

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';

import type { Route } from './+types/reset';

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';

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
  return new Response(render(csrf, token), {
    headers: { ...Object.fromEntries(headers), 'content-type': 'text/html; charset=utf-8' },
  });
}

function render(csrf: string, token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reset password — EduSupervise</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; }
  </style>
</head>
<body>
  <h1>Reset password</h1>
  <form method="post" action="/auth/reset">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <input type="hidden" name="token" value="${escapeAttr(token)}" />
    <label>New password (min 8)<input type="password" name="newPassword" required minlength="8" autocomplete="new-password" /></label>
    <label>Confirm password<input type="password" name="confirmPassword" required minlength="8" autocomplete="new-password" /></label>
    <button type="submit">Reset password</button>
  </form>
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