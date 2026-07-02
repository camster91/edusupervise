// apps/web/app/routes/forgot.tsx — request a password-reset email.
//
// Flow (spec section 5 + 7):
//   1. Loader: render the form
//   2. Action:
//      a. CSRF check
//      b. Rate-limit (3/hr/email)
//      c. Validate email
//      d. Look up the user
//      e. Mint a reset token (HMAC + 1h TTL), persist in auth_verification
//      f. Send the reset email via Resend (or log in dev)
//      g. Always respond 200 with a generic message — never reveal
//         whether the email is on file (prevents user enumeration)
//
// The token travels in the URL fragment of the reset link, so it
// never appears in HTTP server access logs. The reset page extracts
// the fragment and POSTs the token in the body to /reset.

import {
  data,
  Form,
  useActionData,
  useLoaderData,
} from 'react-router';
import type { Route } from './+types/forgot';

import { getSystemClient } from '@edusupervise/db';
import { z } from 'zod';

import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { checkForgotByEmail } from '../../server/rate-limit.server';
import {
  TOKEN_KIND,
  dispatchAuthEmail,
  findUserByEmail,
  mintToken,
  persistToken,
} from '../../server/auth-flows.server';

// Re-use the auth-schema email normalization (lowercase + trim) so
// the route doesn't drift from the spec's email rules.
const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export function meta() {
  return [{ title: 'Forgot password — EduSupervise' }];
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
  const parsed = forgotSchema.safeParse({ email: form.get('email') });
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_input' },
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const rate = checkForgotByEmail(parsed.data.email);
  if (!rate.ok) {
    return Response.json(
      { error: 'rate_limited', detail: 'Too many reset attempts. Try again later.' },
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(rate.retryAfterSec),
        },
      },
    );
  }

  // Look up the user (system role — bypasses RLS for the cross-tenant
  // email lookup; we don't know which school the user belongs to).
  // In a single-tenant Tier 1 this is fine; Tier 2 should switch to
  // a global email-to-school mapping table.
  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    // We still respond 200 to avoid leaking config state; the user
    // gets the same "if we have an account on file..." UX.
    return Response.json({ ok: true });
  }
  const { db, close } = buildDb(systemUrl);
  try {
    const user = await findUserByEmail(db, parsed.data.email);
    if (user) {
      // Mint + persist a reset token.
      const { token, expiresAt } = mintToken(TOKEN_KIND.RESET_PASSWORD, user.email);
      await persistToken(db, TOKEN_KIND.RESET_PASSWORD, user.email, token, expiresAt);

      // Build the reset URL. The token is in the fragment so it
      // never appears in HTTP access logs or Referer headers.
      const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
      const url = `${appUrl}/reset#token=${encodeURIComponent(token)}`;
      await dispatchAuthEmail({
        kind: TOKEN_KIND.RESET_PASSWORD,
        to: user.email,
        url,
        appUrl,
      });
    }
  } finally {
    await close();
  }

  // Always 200 — same response shape whether or not the email exists
  // (prevents user enumeration).
  return Response.json({ ok: true });
}

export default function ForgotPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const data = useActionData() as
    | { ok?: boolean; error?: string; detail?: string }
    | undefined;

  if (data?.ok) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Check your email</h1>
          <p className="text-sm text-slate-600">
            If we have an account on file for that address, you'll get a
            password-reset link in a few minutes. The link expires in 1 hour.
          </p>
          <p className="text-sm text-slate-600 mt-6">
            <a href="/login" className="text-blue-600 hover:underline">Back to sign in</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Forgot password</h1>
        <p className="text-sm text-slate-600 mb-6">
          Enter the email you signed up with. We'll send you a reset link.
        </p>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="csrf" value={csrfToken} />
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
            />
          </label>
          {data?.error && (
            <p className="text-sm text-red-600" role="alert">
              {data.detail ?? data.error}
            </p>
          )}
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
            Send reset link
          </button>
        </Form>
        <p className="text-sm text-slate-600 text-center mt-6">
          <a href="/login" className="text-blue-600 hover:underline">Back to sign in</a>
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(url: string) {
  const { db, close } = getSystemClient(url);
  return { db, close: async () => close() };
}