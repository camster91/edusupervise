// apps/web/app/routes/auth.magic.tsx — request + consume magic-link sign-in.
//
// Spec section 5: magic-link tokens are consumed via POST (never GET).
// The flow has two halves:
//
//   1. Request (POST /auth/magic?intent=request):
//      - CSRF + rate-limit (5/hr/email)
//      - Mint a magic-link token, persist, send the link via email
//      - Always respond 200 (no user enumeration)
//
//   2. Consume (POST /auth/magic with body { token, email }):
//      - CSRF check
//      - Look up the verification row, verify hash + expiry
//      - Mint a session, set the session cookie, redirect to /app
//
// The token travels in the URL fragment of the email link, then
// the consuming page POSTs it in the body. We deliberately keep
// both intents in one file so the route table stays simple; the
// `intent` field on the form body disambiguates.

import { useEffect, useState } from 'react';
import {
  data,
  Form,
  useActionData,
  redirect,
  useLoaderData,
} from 'react-router';
import type { Route } from './+types/auth.magic';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSystemClient, users } from '@edusupervise/db';
import { newSessionTokenFor, sessionCookieAttributes } from '../../server/auth.server';
import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { checkMagicLinkByEmail } from '../../server/rate-limit.server';
import {
  TOKEN_KIND,
  consumeToken,
  dispatchAuthEmail,
  findUserByEmail,
  mintToken,
  persistToken,
} from '../../server/auth-flows.server';

const requestSchema = z.object({
  intent: z.literal('request'),
  email: z.string().trim().toLowerCase().email().max(254),
});

const consumeSchema = z.object({
  intent: z.literal('consume'),
  token: z.string().min(1),
  email: z.string().trim().toLowerCase().email().max(254),
});

export function meta() {
  return [{ title: 'Sign in — EduSupervise' }];
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
  const intent = form.get('intent');

  const systemUrl =
    process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!systemUrl) {
    return Response.json(
      { error: 'server_misconfigured' },
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  // --- Request a magic link -------------------------------------------
  if (intent === 'request') {
    const parsed = requestSchema.safeParse({
      intent: 'request',
      email: form.get('email'),
    });
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const rate = checkMagicLinkByEmail(parsed.data.email);
    if (!rate.ok) {
      return Response.json(
        { error: 'rate_limited', detail: 'Too many sign-in attempts. Try again later.' },
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(rate.retryAfterSec),
          },
        },
      );
    }

    const { db, close } = getSystemClient(systemUrl);
    try {
      const user = await findUserByEmail(db, parsed.data.email);
      if (user) {
        const { token, expiresAt } = mintToken(TOKEN_KIND.MAGIC_LINK, user.email);
        await persistToken(db, TOKEN_KIND.MAGIC_LINK, user.email, token, expiresAt);
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        const url = `${appUrl}/auth/magic#token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
        await dispatchAuthEmail({
          kind: TOKEN_KIND.MAGIC_LINK,
          to: user.email,
          url,
          appUrl,
        });
      }
    } finally {
      await close();
    }
    return Response.json({ ok: true });
  }

  // --- Consume a magic link --------------------------------------------
  if (intent === 'consume') {
    const parsed = consumeSchema.safeParse({
      intent: 'consume',
      token: form.get('token'),
      email: form.get('email'),
    });
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input' },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const { db, close } = getSystemClient(systemUrl);
    try {
      const userRows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, parsed.data.email))
        .limit(1);
      const user = userRows[0];
      if (!user) {
        return Response.json(
          { error: 'magic_link_invalid', detail: 'This sign-in link is invalid or has expired.' },
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }

      const result = await consumeToken(
        db,
        TOKEN_KIND.MAGIC_LINK,
        user.email,
        parsed.data.token,
      );
      if (!result.ok) {
        return Response.json(
          { error: 'magic_link_invalid', detail: 'This sign-in link is invalid or has expired.' },
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }

      const { token: sessionToken } = newSessionTokenFor(user.id);
      // 303 to /app with the session cookie set. RR7 redirect() does
      // not let us append Set-Cookie, so we build the Response by hand.
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/app',
          'Set-Cookie': `edusupervise.session=${sessionToken}; ${sessionCookieAttributes()}`,
        },
      });
    } finally {
      await close();
    }
  }

  return Response.json(
    { error: 'bad_intent' },
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

export default function MagicLinkPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const data = useActionData() as
    | { ok?: boolean; error?: string; detail?: string }
    | undefined;
  const [token, setToken] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [autoSubmitted, setAutoSubmitted] = useState(false);

  // On mount, read the token + email from the URL fragment. If we
  // have both, auto-submit the consume form so the user lands on
  // /app without an extra click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    setToken(params.get('token') ?? '');
    setEmail(params.get('email') ?? '');
  }, []);

  // --- Sent-success view (after request) ---
  if (data?.ok && !token) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Check your email</h1>
          <p className="text-sm text-slate-600">
            If we have an account on file for that address, we just sent a
            sign-in link. The link expires in 60 minutes.
          </p>
        </div>
      </main>
    );
  }

  // --- Consume view (auto-submits) ---
  if (token && email && !autoSubmitted && typeof document !== 'undefined') {
    // Render the auto-submit form once. After we submit, RR7 follows
    // the 303 to /app; we don't need to handle the success state
    // here.
    setTimeout(() => {
      const form = document.getElementById('auto-magic-consume') as HTMLFormElement | null;
      if (form) {
        setAutoSubmitted(true);
        form.submit();
      }
    }, 0);
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        {token ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-1">Signing you in…</h1>
            <p className="text-sm text-slate-600">
              Your magic link is being verified. You'll be redirected in a moment.
            </p>
            <form id="auto-magic-consume" method="post" style={{ display: 'none' }}>
              <input type="hidden" name="intent" value="consume" />
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="email" value={email} />
            </form>
            {data?.error && (
              <p className="text-sm text-red-600 mt-4" role="alert">
                {data.detail ?? data.error}
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-1">Email me a sign-in link</h1>
            <p className="text-sm text-slate-600 mb-6">
              Enter your email and we'll send you a one-time sign-in link.
            </p>
            <Form method="post" className="space-y-4">
          <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="request" />
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
              <button type="submit" className="w-full bg-accent hover:bg-accent-hover text-on-accent font-medium py-2 px-4 rounded-lg transition-colors">
                Send sign-in link
              </button>
            </Form>
            <p className="text-sm text-slate-600 text-center mt-6">
              <a href="/login" className="text-blue-600 hover:underline">Back to sign in</a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}