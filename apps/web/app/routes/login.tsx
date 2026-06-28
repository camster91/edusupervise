// app/routes/login.tsx — sign-in page (email + password).
//
// Form action:
//   - Validates CSRF (validateCsrf) and rate-limit (checkLoginByIp)
//   - Validates body with @edusupervise/schemas#loginSchema (Zod)
//   - Calls better-auth's signInEmail via auth.api.signInEmail
//   - On success, sets the session cookie (already done by better-auth
//     in its Set-Cookie response) and redirects to /app
//
// Loader:
//   - If the user already has a session, redirect to /app
//   - Otherwise render the form
//
// Better-auth's own /api/auth/sign-in/email endpoint is also wired up
// via the catch-all route at api.auth.$.tsx (mounted from auth.server.ts).
// This route exists for the marketing-friendly URL + form-driven UX.

import { useState } from 'react';
import { Link, redirect, useFetcher, type LoaderFunctionArgs } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { loginSchema, type LoginInput } from '@edusupervise/schemas';

import { getAuth, getSession } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { checkLoginByIp } from '~/server/rate-limit.server';
import { csrfFormField } from '~/lib/csrf';

// ----------------------------------------------------------------------------
// Loader — redirect to /app when already signed in
// ----------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request);
  if (session) throw redirect('/app');
  return null;
}

// ----------------------------------------------------------------------------
// Action — handle email/password login
// ----------------------------------------------------------------------------

export async function action({ request }: LoaderFunctionArgs) {
  // CSRF first (rejects cross-origin without reading the cookie).
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  // Rate limit by IP. We read X-Forwarded-For when present so the limit
  // keys off the real client IP behind a reverse proxy (otherwise every
  // request shows up as 127.0.0.1 from the proxy).
  const ip = readClientIp(request);
  const rate = checkLoginByIp(ip);
  if (!rate.ok) {
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        detail: 'Too many login attempts. Try again in a few minutes.',
      }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(rate.retryAfterSec),
        },
      },
    );
  }

  const form = await request.formData();
  const parsed = loginSchema.safeParse({
    email: form.get('email'),
    password: form.get('password'),
  });
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: 'invalid_input',
        detail: parsed.error.issues[0]?.message ?? 'Invalid input',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const auth = getAuth();
  try {
    // better-auth sets the session cookie via Set-Cookie on success.
    // We forward those cookies onto the response so the browser picks
    // them up after the redirect.
    const result = await auth.api.signInEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
      },
      headers: request.headers,
      asResponse: true,
      returnHeaders: true,
    });

    // The `result` is the better-auth Response. Forward its Set-Cookie
    // headers onto our 303 redirect to /app.
    const headers = new Headers({ Location: '/app' });
    const setCookies = result.headers.getSetCookie();
    for (const c of setCookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 303, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'invalid_credentials',
        detail: 'Email or password is incorrect.',
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export default function Login() {
  const fetcher = useFetcher();
  const [serverError, setServerError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });

  const csrf = csrfFormField();

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    const fd = new FormData();
    fd.append('email', values.email);
    fd.append('password', values.password);
    fd.append(csrf.name, csrf.value);
    fetcher.submit(fd, { method: 'post' });
  }

  // Surface server errors from the action response.
  const state = fetcher.data as
    | { error: string; detail?: string }
    | undefined;
  if (state?.error && state.error !== serverError) {
    // Render-time display only — keeps the message visible.
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Sign in to EduSupervise</h1>
      <p>
        Need an account? <Link to="/signup">Create your school</Link>.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <input type="hidden" name={csrf.name} value={csrf.value} />

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            {...register('email')}
            aria-invalid={errors.email ? 'true' : undefined}
          />
          {errors.email && (
            <p role="alert" style={{ color: '#b91c1c' }}>
              {errors.email.message}
            </p>
          )}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            {...register('password')}
            aria-invalid={errors.password ? 'true' : undefined}
          />
          {errors.password && (
            <p role="alert" style={{ color: '#b91c1c' }}>
              {errors.password.message}
            </p>
          )}
        </div>

        {state?.error && (
          <p role="alert" style={{ color: '#b91c1c' }}>
            {state.detail ?? state.error}
          </p>
        )}

        <button type="submit" disabled={fetcher.state !== 'idle'}>
          {fetcher.state === 'idle' ? 'Sign in' : 'Signing in...'}
        </button>
      </form>

      <p style={{ marginTop: '2rem' }}>
        <Link to="/forgot">Forgot password?</Link>
        {' · '}
        <Link to="/auth/magic">Email me a sign-in link</Link>
      </p>
    </main>
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function readClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}