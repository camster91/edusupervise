// app/routes/forgot.tsx — request a password-reset email.
//
// Form action:
//   1. CSRF check
//   2. Rate-limit by email (3 / hr / email per spec)
//   3. Validate email shape (Zod)
//   4. Better-auth's `forgetPassword` API — mints a single-use token,
//      stores it in `auth_verification`, and calls our `sendResetPassword`
//      callback (which sends the Resend email OR logs the URL in dev).
//
// The route always responds 200 with a generic message, regardless of
// whether the email exists — to prevent user enumeration. Better-auth's
// `forgetPassword` already does this internally; we just render the
// success state on the page.
//
// Note: we intentionally do NOT rate-limit by IP for forgot-password
// requests — the email is the right key (an attacker rotating IPs would
// otherwise bypass the limit). The 3/hr/email cap from spec section 5.

import { useState } from 'react';
import { Link, useFetcher } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ActionFunctionArgs } from 'react-router';

import { forgotPasswordSchema, type ForgotPasswordInput } from '@edusupervise/schemas';

import { getAuth } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { checkForgotByEmail } from '~/server/rate-limit.server';
import { csrfFormField } from '~/lib/csrf';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = forgotPasswordSchema.safeParse({
    email: form.get('email'),
  });
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_input' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Rate-limit BEFORE talking to better-auth (we don't want the email
  // pipeline to be DoS-able by spammed forgot requests).
  const rate = checkForgotByEmail(parsed.data.email);
  if (!rate.ok) {
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        detail: 'Too many reset attempts. Try again later.',
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

  // Better-auth's forgetPassword — always returns OK regardless of
  // whether the email exists (no user enumeration).
  const auth = getAuth();
  try {
    await auth.api.forgetPassword({
      body: {
        email: parsed.data.email,
        redirectTo: '/reset',
      },
      headers: request.headers,
    });
  } catch (err) {
    // Swallow — we don't want to leak whether the email exists.
  }

  // Always return the same shape, regardless of whether the email is
  // registered. The user-facing message is "if we have an account on
  // file for this address, you'll get an email".
  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export default function Forgot() {
  const fetcher = useFetcher();
  const [sent, setSent] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  const csrf = csrfFormField();

  async function onSubmit(values: ForgotPasswordInput) {
    const fd = new FormData();
    fd.append('email', values.email);
    fd.append(csrf.name, csrf.value);
    fetcher.submit(fd, { method: 'post' });
    setSent(true);
  }

  if (sent || fetcher.data) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Check your email</h1>
        <p>
          If we have an account on file for that address, you'll get a
          password-reset link in a few minutes. The link expires in 1 hour.
        </p>
        <p>
          <Link to="/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Forgot password</h1>
      <p>
        Enter the email you signed up with. We'll send you a reset link.
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

        <button type="submit" disabled={fetcher.state !== 'idle'}>
          {fetcher.state === 'idle' ? 'Send reset link' : 'Sending...'}
        </button>
      </form>

      <p style={{ marginTop: '2rem' }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  );
}