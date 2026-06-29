// apps/web/app/routes/reset.tsx — consume a password-reset token.
//
// The token travels in the URL fragment (#token=...) which is read on
// mount. The form POSTs the token in the body — per spec section 5,
// tokens must NEVER be in URLs that hit the server (avoids logging
// + Referer leaks). The form's hidden `token` field is populated
// from the fragment by the client.

import { useEffect, useState } from 'react';
import { Form, useActionData } from 'react-router';
import type { Route } from './+types/reset';
import { eq } from 'drizzle-orm';
import { hashPassword, newSessionTokenFor, sessionCookieAttributes } from '../server/auth.server';
import { validateCsrf } from '../server/csrf.server';
import {
  TOKEN_KIND,
  consumeToken,
} from '../server/auth-flows.server';
import { getSystemClient, users } from '@edusupervise/db';
import { z } from 'zod';

const resetSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export function meta() {
  return [{ title: 'Reset password — EduSupervise' }];
}

export async function loader() {
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const parsed = resetSchema.safeParse({
    token: form.get('token'),
    newPassword: form.get('newPassword'),
  });
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input', detail: parsed.error.issues[0]?.message },
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // We need the email to scope the consume lookup. The forgot-email
  // page sends the link with the token in the fragment; we expect
  // the client to also include the email in a hidden form field. If
  // the email is missing, we 400 — the user must retry the flow.
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email) {
    return Response.json(
      { error: 'missing_email', detail: 'Email is required to redeem a reset token.' },
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
    // Find the user first so we have a school_id to set on the
    // session — and so we can validate the email/token pair.
    const userRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      return Response.json(
        { error: 'reset_failed', detail: 'This reset link is invalid or has expired.' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const result = await consumeToken(
      db,
      TOKEN_KIND.RESET_PASSWORD,
      user.email,
      parsed.data.token,
    );
    if (!result.ok) {
      return Response.json(
        { error: 'reset_failed', detail: 'This reset link is invalid or has expired.' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Update the password hash. The system role has BYPASSRLS so this
    // write doesn't need app.school_id to be set.
    const newHash = await hashPassword(parsed.data.newPassword);
    await db
      .update(users)
      .set({ passwordHash: newHash })
      .where(eq(users.id, user.id));

    // Auto-sign-in: mint a session token and set the cookie.
    const { token: sessionToken } = newSessionTokenFor(user.id);
    return new Response(
      JSON.stringify({ ok: true, redirectTo: '/app' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'Set-Cookie': `edusupervise.session=${sessionToken}; ${sessionCookieAttributes()}`,
        },
      },
    );
  } finally {
    await close();
  }
}

export default function ResetPage() {
  const data = useActionData() as
    | { ok?: boolean; redirectTo?: string; error?: string; detail?: string }
    | undefined;
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

  // Auto-redirect on success.
  useEffect(() => {
    if (data?.ok && data.redirectTo) {
      window.location.href = data.redirectTo;
    }
  }, [data]);

  if (data?.ok) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Password updated</h1>
          <p className="text-sm text-slate-600">Redirecting you to the dashboard…</p>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Invalid reset link</h1>
          <p className="text-sm text-slate-600">
            The password-reset link you used is missing its token. Open the link
            from the email, or request a new one.
          </p>
          <p className="text-sm text-slate-600 mt-6">
            <a href="/forgot" className="text-blue-600 hover:underline">Request a new reset link</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Set a new password</h1>
        <p className="text-sm text-slate-600 mb-6">
          Choose a new password for your EduSupervise account.
        </p>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="email" value={email} />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">New password</span>
            <input
              name="newPassword"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
            />
          </label>
          {data?.error && (
            <p className="text-sm text-red-600" role="alert">
              {data.detail ?? data.error}
            </p>
          )}
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
            Update password
          </button>
        </Form>
      </div>
    </main>
  );
}