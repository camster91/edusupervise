// apps/web/app/routes/verify-email.tsx — /verify-email (UI).
//
// The token is read from the URL (?token=...) — the user clicked the
// link in their email. We auto-submit on page load (a small inline
// script) so the POST happens without a manual click. The POST itself
// goes to /auth/verify-email with the token in the BODY.
//
// Why auto-submit: the verify-email flow has no user-supplied data
// (the token is already in the URL). A second click is friction.

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';

import type { Route } from './+types/verify-email';

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
  <title>Verifying… — EduSupervise</title>
</head>
<body>
  <h1>Verifying your email…</h1>
  <form id="verify-form" method="post" action="/auth/verify-email">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <input type="hidden" name="token" value="${escapeAttr(token)}" />
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.getElementById('verify-form').submit();</script>
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