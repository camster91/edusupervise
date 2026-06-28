// apps/web/app/routes/signup.tsx — /signup (UI).
//
// Renders the school + admin signup form. POSTs to /auth/signup which
// runs the transaction.

import { redirect } from 'react-router';

import {
  buildCsrfSetCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from '~/server/csrf.server';
import { getSession } from '~/server/auth.server';

import type { Route } from './+types/signup';

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) return redirect('/app');

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
  return new Response(renderSignupPage(csrf), {
    headers: { ...Object.fromEntries(headers), 'content-type': 'text/html; charset=utf-8' },
  });
}

function renderSignupPage(csrf: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create your school — EduSupervise</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p.lead { color: #555; margin-bottom: 1.5rem; }
    fieldset { border: 1px solid #ddd; padding: 1rem; margin-bottom: 1rem; }
    legend { padding: 0 0.5rem; font-weight: 600; }
    label { display: block; margin-top: 0.75rem; font-size: 0.9rem; }
    input { display: block; width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box; }
    .honeypot { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    button { margin-top: 1.5rem; padding: 0.7rem 1.5rem; }
  </style>
</head>
<body>
  <h1>Create your school</h1>
  <p class="lead">30-day trial. No card required. Pro features on day one.</p>
  <form method="post" action="/auth/signup">
    <input type="hidden" name="_csrf" value="${escapeAttr(csrf)}" />
    <!-- honeypot -->
    <div class="honeypot"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>

    <fieldset>
      <legend>School</legend>
      <label>School name<input type="text" name="schoolName" required maxlength="200" /></label>
      <label>School slug (URL-safe, e.g. <code>maple-elementary</code>)<input type="text" name="schoolSlug" required pattern="[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?" /></label>
      <label>Timezone<input type="text" name="timezone" value="America/Toronto" required /></label>
      <label>Cycle days<input type="number" name="cycleDays" value="5" min="1" max="10" required /></label>
      <label>School year start<input type="date" name="schoolYearStart" required /></label>
      <label>School year end<input type="date" name="schoolYearEnd" required /></label>
    </fieldset>

    <fieldset>
      <legend>First admin</legend>
      <label>Your name<input type="text" name="adminName" required maxlength="200" /></label>
      <label>Email<input type="email" name="adminEmail" required /></label>
      <label>Password (min 8)<input type="password" name="adminPassword" required minlength="8" /></label>
    </fieldset>

    <button type="submit">Create school & sign in</button>
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