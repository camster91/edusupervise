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
import { Form, useActionData, useSearchParams } from 'react-router';
import type { Route } from './+types/verify-email';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSystemClient, users } from '@edusupervise/db';
import { newSessionTokenFor, sessionCookieAttributes } from '../../server/auth.server';
import { validateCsrf } from '../../server/csrf.server';
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

export async function loader() {
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
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
          'Set-Cookie': `edusupervise.session=${sessionToken}; ${sessionCookieAttributes()}`,
        },
      });
    }
    return Response.json({ ok: true });
  } finally {
    await close();
  }
}

/**
 * Helper used by the signup route (and admin-invite) to issue a
 * verification email. Returns true on success.
 */
export async function sendEmailVerification(
  email: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return { ok: false, error: 'server_misconfigured' };
  }
  const { db, close } = getSystemClient(systemUrl);
  try {
    const user = await findUserByEmail(db, email);
    if (!user) return { ok: false, error: 'user_not_found' };
    const { token, expiresAt } = mintToken(TOKEN_KIND.VERIFY_EMAIL, user.email);
    await persistToken(db, TOKEN_KIND.VERIFY_EMAIL, user.email, token, expiresAt);
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const url = `${appUrl}/verify-email?auto=1#token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
    return { ok: true, url };
  } finally {
    await close();
  }
}

export default function VerifyEmailPage() {
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
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Email verified</h1>
          <p className="text-sm text-slate-600">
            Your email is now verified. You can sign in.
          </p>
          <p className="text-sm text-slate-600 mt-6">
            <a href="/login" className="text-blue-600 hover:underline">Sign in</a>
          </p>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Invalid verification link</h1>
          <p className="text-sm text-slate-600">
            The link you used is missing its token. Open the link from your
            verification email.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Verify your email</h1>
        <p className="text-sm text-slate-600 mb-6">
          Click the button below to confirm your email.
        </p>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="email" value={email} />
          {data?.error && (
            <p className="text-sm text-red-600" role="alert">
              {data.detail ?? data.error}
            </p>
          )}
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
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