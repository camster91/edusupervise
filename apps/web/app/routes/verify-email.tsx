// apps/web/app/routes/verify-email.tsx — email verification (POST).
//
// Per spec section 5 the verification token is consumed via POST, not
// GET. The flow:
//
//   1. Request step (called from signup.tsx when sendOnSignUp is
//      true) — not implemented here. Email verification in Tier 1 is
//      a nice-to-have; production code would call the helper
//      functions below from the signup flow.
//   2. Consume step (POST /verify-email with body { token, email }):
//      - CSRF check
//      - Look up the user, verify token via auth-flows.consumeToken
//      - Update users.email_verified_at
//      - Auto-sign-in if `?auto=1` query param is set
//
// The token is in the URL fragment of the email link; the consuming
// page reads it on mount and POSTs it in the body.

import { useEffect, useState } from 'react';
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useSearchParams,
} from 'react-router';
import type { Route } from './+types/verify-email';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSystemClient, users } from '@edusupervise/db';
import { newSessionTokenFor, setSessionCookie } from '../../server/auth.server';
import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import {
  TOKEN_KIND,
  consumeToken,
  findUserByEmail,
  mintToken,
  persistToken,
} from '../../server/auth-flows.server';

const consumeSchema = z.object({
  token: z.string().min(1),
  email: z.string().trim().toLowerCase().email().max(254),
});

export function meta() {
  return [{ title: 'Verify your email — EduSupervise' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // ensureCsrfCookie reads the existing cookie or mints a fresh one,
  // returning the token (to embed in the HTML form) and the Set-Cookie
  // header value (to attach to the response when we minted). Using
  // RR7's `data()` wrapper keeps the loader-data shape consistent
  // across visits — the previous pattern returned a plain object
  // when the cookie was present and a Response-with-Set-Cookie when
  // it wasn't, which triggered React #418/#425 hydration warnings on
  // subsequent visits.
  const { token, setCookie } = ensureCsrfCookie(request);
  const headers: HeadersInit | undefined = setCookie
    ? { 'Set-Cookie': setCookie }
    : undefined;
  return data({ csrfToken: token }, headers ? { headers } : undefined);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const csrf = validateCsrfWithFormToken(request, form);
  if (!csrf.ok) return csrf.response;
  const parsed = consumeSchema.safeParse({
    token: form.get('token'),
    email: form.get('email'),
  });
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input', detail: parsed.error.issues[0]?.message },
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return Response.json(
      { error: 'server_misconfigured' },
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  const { db, close } = getSystemClient(systemUrl);
  try {
    const user = await findUserByEmail(db, parsed.data.email);
    if (!user) {
      return Response.json(
        { error: 'verify_failed', detail: 'This verification link is invalid or has expired.' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const result = await consumeToken(
      db,
      TOKEN_KIND.VERIFY_EMAIL,
      user.email,
      parsed.data.token,
    );
    if (!result.ok) {
      return Response.json(
        { error: 'verify_failed', detail: 'This verification link is invalid or has expired.' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Mark the user verified. The system role has BYPASSRLS so this
    // write doesn't need app.school_id to be set.
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, user.id));

    // Auto-sign-in if requested.
    const url = new URL(request.url);
    if (url.searchParams.get('auto') === '1') {
      const { token: sessionToken } = newSessionTokenFor(user.id);
      return new Response(JSON.stringify({ ok: true, redirectTo: '/app' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'Set-Cookie': setSessionCookie(sessionToken),
        },
      });
    }
    return Response.json({ ok: true });
  } finally {
    await close();
  }
}

export default function VerifyEmailPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const data = useActionData() as
    | { ok?: boolean; redirectTo?: string; error?: string; detail?: string }
    | undefined;
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState<string>('');
  const [email, setEmail] = useState<string>('');

  // Read the token + email from the URL fragment on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    setToken(params.get('token') ?? '');
    setEmail(params.get('email') ?? '');
  }, []);

  // Auto-redirect on success when ?auto=1.
  useEffect(() => {
    if (data?.ok && data.redirectTo) {
      window.location.href = data.redirectTo;
    }
  }, [data]);

  if (data?.ok && !data.redirectTo) {
    return (
      <main className="min-h-screen grid place-items-center bg-surface-2 px-4">
        <div className="w-full max-w-sm bg-surface rounded-lg shadow-elev-1 border border-border p-8">
          <h1 className="text-title-1 font-bold text-primary mb-1">Email verified</h1>
          <p className="text-sm text-secondary">
            Your email is now verified. You can sign in.
          </p>
          <p className="text-sm text-secondary mt-6">
            <a href="/login" className="text-accent hover:underline">Sign in</a>
          </p>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="min-h-screen grid place-items-center bg-surface-2 px-4">
        <div className="w-full max-w-sm bg-surface rounded-lg shadow-elev-1 border border-border p-8">
          <h1 className="text-title-1 font-bold text-primary mb-1">Invalid verification link</h1>
          <p className="text-sm text-secondary">
            The link you used is missing its token. Open the link from your
            verification email.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center bg-surface-2 px-4">
      <div className="w-full max-w-sm bg-surface rounded-lg shadow-elev-1 border border-border p-8">
        <h1 className="text-title-1 font-bold text-primary mb-1">Verify your email</h1>
        <p className="text-sm text-secondary mb-6">
          Click the button below to confirm your email.
        </p>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="email" value={email} />
          {data?.error && (
            <p className="text-sm text-error" role="alert">
              {data.detail ?? data.error}
            </p>
          )}
          <button type="submit" className="w-full bg-accent hover:bg-accent-hover text-on-accent font-medium py-2 px-4 rounded-lg transition-colors">
            Verify email
          </button>
        </Form>
      </div>
    </main>
  );
}

// Suppress unused-var warning for `searchParams` — kept for future
// ?auto=1 deep-linking.
void useSearchParams;