// app/routes/auth.magic.tsx — consume a magic-link token via POST.
//
// Per spec section 5, magic links are consumed via POST not GET. The
// user receives an email with a link like:
//
//   https://edusupervise.ashbi.ca/auth/magic#token=<token>
//
// The page reads the token from the URL fragment (never sent to the
// server) and POSTs it in the form body. This avoids the token
// appearing in:
//   - HTTP server access logs (no GET request with the token in the URL)
//   - Browser history (the fragment isn't part of the canonical URL)
//   - Referer headers (fragments are stripped)
//
// The form submits via JS (useFetcher) — not a plain HTML form post —
// so the action sees a multipart/form-data body with the token in it.

import { useEffect, useState } from 'react';
import { redirect, useFetcher, type ActionFunctionArgs } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { magicLinkConsumeSchema, type MagicLinkConsumeInput } from '@edusupervise/schemas';

import { getAuth } from '~/server/auth.server';
import { validateCsrf } from '~/server/csrf.server';
import { csrfFormField } from '~/lib/csrf';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = magicLinkConsumeSchema.safeParse({
    token: form.get('token'),
  });
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'invalid_input' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Magic-link verification — better-auth's plugin endpoint. Returns a
  // session cookie on success.
  const auth = getAuth();
  try {
    const result = await auth.api.magicLinkVerify({
      query: { token: parsed.data.token },
      headers: request.headers,
      asResponse: true,
      returnHeaders: true,
    });

    const headers = new Headers({ Location: '/app' });
    const setCookies = result.headers.getSetCookie();
    for (const c of setCookies) headers.append('Set-Cookie', c);
    await result.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 303, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'magic_link_invalid',
        detail: 'This sign-in link is invalid or has expired.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
}

export default function MagicLinkConsume() {
  const fetcher = useFetcher();
  const [token, setToken] = useState<string>('');
  const [autoSubmitted, setAutoSubmitted] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    setToken(params.get('token') ?? '');
  }, []);

  const { register, handleSubmit } = useForm<MagicLinkConsumeInput>({
    resolver: zodResolver(magicLinkConsumeSchema),
  });

  const csrf = csrfFormField();

  // Auto-submit on mount when we have a token + a fresh CSRF cookie.
  // This makes the magic link truly one-click: the user clicks the link
  // in their email, lands on this page, and is signed in immediately.
  useEffect(() => {
    if (!token || autoSubmitted) return;
    const csrfValue = csrf.value;
    if (!csrfValue) return; // wait for the cookie
    setAutoSubmitted(true);
    const fd = new FormData();
    fd.append('token', token);
    fd.append(csrf.name, csrfValue);
    fetcher.submit(fd, { method: 'post' });
  }, [token, csrf.value, csrf.name, autoSubmitted, fetcher]);

  if (!token) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Invalid sign-in link</h1>
        <p>
          The sign-in link you used is missing its token. Open the link from
          your email, or request a new one.
        </p>
        <p>
          <a href="/login">Back to sign in</a>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Signing you in...</h1>
      <p>
        Your magic link is being verified. You'll be redirected in a moment.
      </p>
    </main>
  );
}