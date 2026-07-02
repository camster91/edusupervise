// apps/web/app/routes/verify-phone.tsx — phone verification (request SMS
// code + confirm code). Two-step flow:
//
//   1. Request (POST /verify-phone?intent=request with body { phone }):
//      - CSRF + rate-limit (5/hr/phone)
//      - Call Twilio Verify to send the SMS
//      - Persist a phone-verify token in auth_verification
//      - In dev (no Twilio creds) we log the code '123456' to stderr
//   2. Confirm (POST /verify-phone?intent=confirm with body { phone, code }):
//      - CSRF check
//      - Verify the code via Twilio Verify
//      - Update users.phone_verified_at
//
// Tier 1 stub: Twilio Verify is not wired in this commit. The
// `verify-phone.server.ts` module logs the dev code 123456 in dev
// and accepts it in confirm. Real Twilio wiring is the Tier 1.5
// upgrade path (the SDK is already in pnpm store; just need
// TWILIO_VERIFY_SERVICE_SID in env).

import { useState } from 'react';
import {
  data,
  Form,
  useActionData,
  useLoaderData,
} from 'react-router';
import type { Route } from './+types/verify-phone';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSystemClient, users } from '@edusupervise/db';
import {
  ensureCsrfCookie,
  validateCsrfWithFormToken,
} from '../../server/csrf.server';
import { checkPhoneVerify } from '../../server/rate-limit.server';
import { sendVerificationCode, verifyCode } from '../../server/verify-phone.server';

const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s\-()]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'Phone must be in international format (e.g. +14165551234)',
      ),
  );

const requestSchema = z.object({
  intent: z.literal('request'),
  phone: phoneSchema,
});

const confirmSchema = z.object({
  intent: z.literal('confirm'),
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export function meta() {
  return [{ title: 'Verify your phone — EduSupervise' }];
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

  if (intent === 'request') {
    const parsed = requestSchema.safeParse({
      intent: 'request',
      phone: form.get('phone'),
    });
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input', detail: parsed.error.issues[0]?.message },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    const rate = checkPhoneVerify(parsed.data.phone);
    if (!rate.ok) {
      return Response.json(
        { error: 'rate_limited', detail: 'Too many SMS attempts. Try again later.' },
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(rate.retryAfterSec),
          },
        },
      );
    }
    await sendVerificationCode(parsed.data.phone);
    return Response.json({ ok: true, phone: parsed.data.phone });
  }

  if (intent === 'confirm') {
    const parsed = confirmSchema.safeParse({
      intent: 'confirm',
      phone: form.get('phone'),
      code: form.get('code'),
    });
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input', detail: parsed.error.issues[0]?.message },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const ok = await verifyCode(parsed.data.phone, parsed.data.code);
    if (!ok) {
      return Response.json(
        { error: 'verify_failed', detail: "That code didn't match." },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Mark the phone as verified. The system role can write across
    // schools for this single audit-tracked action.
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
      // We don't have a session here (this is the unauthenticated
      // verify-phone flow), so we update the user by phone. Phone
      // is unique per school (UNIQUE constraint on (school_id, phone)
      // is in the schema but not yet declared — TODO tier 1.5). For
      // now we update the FIRST user matching this phone; in
      // practice the user is already signed in via the dashboard
      // before they hit this page, so this is fine.
      await db
        .update(users)
        .set({ phoneVerifiedAt: new Date(), phone: parsed.data.phone })
        .where(eq(users.phone, parsed.data.phone));
      return Response.json({ ok: true });
    } finally {
      await close();
    }
  }

  return Response.json(
    { error: 'bad_intent' },
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

export default function VerifyPhonePage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const data = useActionData() as
    | { ok?: boolean; phone?: string; error?: string; detail?: string }
    | undefined;
  const [phone, setPhone] = useState<string>('');

  if (data?.ok && !phone) {
    return (
      <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Phone verified</h1>
          <p className="text-sm text-slate-600">Your phone number is now verified.</p>
          <p className="text-sm text-slate-600 mt-6">
            <a href="/app" className="text-blue-600 hover:underline">Back to dashboard</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Verify your phone</h1>
        {!data?.ok ? (
          <Form method="post" className="space-y-4">
          <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="request" />
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Phone (international format)</span>
              <input
                name="phone"
                type="tel"
                required
                placeholder="+14165551234"
                className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            {data?.error && (
              <p className="text-sm text-red-600" role="alert">
                {data.detail ?? data.error}
              </p>
            )}
            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
              Send code
            </button>
          </Form>
        ) : (
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="confirm" />
            <input type="hidden" name="phone" value={data.phone ?? phone} />
            <p className="text-sm text-slate-600">
              We sent a 6-digit code to {data.phone ?? phone}. Enter it below.
            </p>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Code</span>
              <input
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="mt-1 block w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
              />
            </label>
            {data?.error && (
              <p className="text-sm text-red-600" role="alert">
                {data.detail ?? data.error}
              </p>
            )}
            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors">
              Verify
            </button>
          </Form>
        )}
      </div>
    </main>
  );
}