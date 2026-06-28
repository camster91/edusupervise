// apps/web/app/routes/auth.login.tsx — POST /auth/login.
//
// Validates input + CSRF, calls better-auth's signInEmail, forwards the
// session cookie, and rotates the CSRF cookie.
//
// Rate limit: 5 / 15 min / IP (per spec section 5).
// Origin check: cross-origin POSTs return 403 (the better-auth handler
// also enforces this, but we double-check because we read the body).

import { redirect } from 'react-router';

import { loginSchema } from '@edusupervise/schemas/auth';

import { getAuth } from '~/server/auth.server';
import {
  buildCsrfSetCookieSecure,
  generateCsrfToken,
  validateCsrfFromForm,
} from '~/server/csrf.server';
import {
  buildRateLimitedResponse,
  consume,
  RATE_LIMITS,
} from '~/server/rate-limit.server';

import type { Route } from './+types/auth.login';

export async function action({ request }: Route.ActionArgs) {
  // 1. CSRF.
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  // 2. Rate limit by IP.
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const rl = consume('login', ip, RATE_LIMITS.login);
  if (!rl.allowed) return buildRateLimitedResponse(rl);

  // 3. Parse.
  const raw = Object.fromEntries(formData);
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'invalid_input',
        issues: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  // 4. Hand off to better-auth.
  const result = await getAuth().api.signInEmail({
    body: {
      email: parsed.data.email,
      password: parsed.data.password,
    },
    asResponse: true,
    headers: request.headers,
  });

  if (!result.ok) {
    // better-auth returns 401 on bad credentials, 403 on rate limit, etc.
    // Pass the body through so the client can show the same error.
    const body = await result.clone().text().catch(() => '');
    return new Response(body, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // 5. Build the success response: redirect to redirectTo or /app,
  //    forward session cookie, rotate CSRF.
  const newCsrf = generateCsrfToken();
  const headers = new Headers();
  headers.set('location', parsed.data.redirectTo || '/app');
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