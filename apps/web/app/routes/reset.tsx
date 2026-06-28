// app/routes/reset.tsx — consume a password-reset token.
//
// Per spec section 5 the token travels in the REQUEST BODY (POST) —
// never in the URL — to avoid leakage via Referer headers / browser
// history. The user lands on this page via a link like /reset that
// has the token in the URL fragment (#token=...), which the page reads
// with `useLocation().hash`. The form then POSTs the token + new
// password via the form body, where the server-side action reads it
// with `request.formData()`.
//
// Why the URL fragment instead of a query param:
//   - Fragments are NEVER sent to the server (browsers strip them).
//   - The token never appears in nginx access logs, Referer headers, or
//     server-side request logs.
//   - The fragment is then POSTed via the form body, which IS sent to
//     the server — but only over TLS, so the token is encrypted in
//     transit.

import { useEffect, useState } from 'react';
import { Link, useFetcher, type ActionFunctionArgs } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { resetPasswordSchema, type ResetPasswordInput } from '@edusupervise/schemas';

import { getAuth } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { csrfFormField } from '~/lib/csrf';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = resetPasswordSchema.safeParse({
    token: form.get('token'),
    newPassword: form.get('newPassword'),
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
    await auth.api.resetPassword({
      body: {
        token: parsed.data.token,
        newPassword: parsed.data.newPassword,
      },
      headers: request.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'reset_failed',
        detail: 'This reset link is invalid or has expired.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export default function Reset() {
  const fetcher = useFetcher();
  const [token, setToken] = useState<string>('');

  // Read the token from the URL fragment on mount. The email link points
  // to /reset#token=<token>; the browser hands the fragment to JS but
  // never to the server.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    setToken(params.get('token') ?? '');
  }, []);

  const { register, handleSubmit, formState: { errors } } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token: '' },
  });

  const csrf = csrfFormField();

  // Surface the token from the URL fragment into the form's `token` field
  // so react-hook-form's validation picks it up.
  useEffect(() => {
    if (token) {
      register('token');
      // Direct DOM mutation for the hidden input; controlled-input dance
      // is overkill for a value that never changes after mount.
      const el = document.getElementById('reset-token') as HTMLInputElement | null;
      if (el) el.value = token;
    }
  }, [token, register]);

  async function onSubmit(values: ResetPasswordInput) {
    const fd = new FormData();
    fd.append('token', values.token || token);
    fd.append('newPassword', values.newPassword);
    fd.append(csrf.name, csrf.value);
    fetcher.submit(fd, { method: 'post' });
  }

  const state = fetcher.data as { ok?: boolean; error?: string; detail?: string } | undefined;

  if (state?.ok) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Password updated</h1>
        <p>You can now sign in with your new password.</p>
        <p>
          <Link to="/login">Sign in</Link>
        </p>
      </main>
    );
  }

  if (!token) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Invalid reset link</h1>
        <p>
          The password-reset link you used is missing its token. Make sure
          you opened the link from the email, or request a new one.
        </p>
        <p>
          <Link to="/forgot">Request a new reset link</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Set a new password</h1>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <input type="hidden" name={csrf.name} value={csrf.value} />
        <input id="reset-token" type="hidden" name="token" defaultValue={token} />

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="newPassword">New password</label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            {...register('newPassword')}
            aria-invalid={errors.newPassword ? 'true' : undefined}
          />
          {errors.newPassword && (
            <p role="alert" style={{ color: '#b91c1c' }}>
              {errors.newPassword.message}
            </p>
          )}
        </div>

        {state?.error && (
          <p role="alert" style={{ color: '#b91c1c' }}>
            {state.detail ?? state.error}
          </p>
        )}

        <button type="submit" disabled={fetcher.state !== 'idle'}>
          {fetcher.state === 'idle' ? 'Update password' : 'Updating...'}
        </button>
      </form>
    </main>
  );
}