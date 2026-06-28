// app/routes/verify-email.tsx — consume an email-verification token.
//
// Spec section 5: token travels in the request body (POST), not the URL.
// Same URL-fragment pattern as magic-link / reset.

import { useEffect, useState } from 'react';
import { Link, useFetcher, type ActionFunctionArgs } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { verifyEmailSchema, type VerifyEmailInput } from '@edusupervise/schemas';

import { getAuth } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { csrfFormField } from '~/lib/csrf';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = verifyEmailSchema.safeParse({
    token: form.get('token'),
  });
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_input' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const auth = getAuth();
  try {
    await auth.api.verifyEmail({
      query: { token: parsed.data.token },
      headers: request.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'verify_failed',
        detail: 'This verification link is invalid or has expired.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export default function VerifyEmail() {
  const fetcher = useFetcher();
  const [token, setToken] = useState<string>('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    setToken(params.get('token') ?? '');
  }, []);

  const { register } = useForm<VerifyEmailInput>({
    resolver: zodResolver(verifyEmailSchema),
  });

  const csrf = csrfFormField();

  async function onSubmit() {
    if (!token) return;
    const fd = new FormData();
    fd.append('token', token);
    fd.append(csrf.name, csrf.value);
    fetcher.submit(fd, { method: 'post' });
  }

  // Auto-submit on token.
  useEffect(() => {
    if (token && csrf.value && fetcher.state === 'idle') {
      onSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, csrf.value]);

  const state = fetcher.data as { ok?: boolean; error?: string; detail?: string } | undefined;

  if (state?.ok) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Email verified</h1>
        <p>Your email is now verified. You can sign in.</p>
        <p>
          <Link to="/login">Sign in</Link>
        </p>
      </main>
    );
  }

  if (!token) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Invalid verification link</h1>
        <p>
          The link you used is missing its token. Open the link from your
          verification email.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Verifying your email...</h1>
      <p>This usually takes a moment.</p>
      {state?.error && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {state.detail ?? state.error}
        </p>
      )}
    </main>
  );
}