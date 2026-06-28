// app/routes/verify-phone.tsx — phone verification (request SMS code +
// confirm code). Tier 1 ships the form + validation + rate limit; the
// actual SMS dispatch via Twilio Verify is wired in apps/web/server/verify-phone.server.ts
// (placeholder; full Twilio wiring is in a follow-up task).

import { useState } from 'react';
import { Link, useFetcher } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ActionFunctionArgs } from 'react-router';

import {
  phoneConfirmSchema,
  phoneRequestSchema,
  type PhoneConfirmInput,
  type PhoneRequestInput,
} from '@edusupervise/schemas';

import { validateCsrf } from '~/server/csrf.server';
import { checkPhoneVerify } from '~/server/rate-limit.server';
import { csrfFormField } from '~/lib/csrf';
import { getDb } from '~/server/db.server';
import {
  getSystemClient,
  users,
  eq,
  withUserContext,
  type Db,
} from '@edusupervise/db';
import { getSession } from '~/server/auth.server';

export async function action({ request }: ActionFunctionArgs) {
  const csrf = validateCsrf(request);
  if (!csrf.ok) return csrf.response;

  const form = await request.formData();
  const intent = form.get('intent');

  if (intent === 'request') {
    const parsed = phoneRequestSchema.safeParse({ phone: form.get('phone') });
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'invalid_input' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const rate = checkPhoneVerify(parsed.data.phone);
    if (!rate.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(rate.retryAfterSec),
        },
      });
    }
    // Send the SMS via Twilio Verify. Real implementation lands in the
    // verify-phone.server.ts module — for now, log the code in dev.
    const { sendVerificationCode } = await import('~/server/verify-phone.server');
    await sendVerificationCode(parsed.data.phone);
    return new Response(JSON.stringify({ ok: true, phone: parsed.data.phone }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (intent === 'confirm') {
    const parsed = phoneConfirmSchema.safeParse({
      phone: form.get('phone'),
      code: form.get('code'),
    });
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'invalid_input' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Verify the code via Twilio Verify. On success, mark the user's
    // phone_verified_at column.
    const { verifyCode } = await import('~/server/verify-phone.server');
    const ok = await verifyCode(parsed.data.phone, parsed.data.code);
    if (!ok) {
      return new Response(
        JSON.stringify({ error: 'verify_failed', detail: 'That code didn\'t match.' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // Update the user's phone_verified_at via the system role (users
    // has RLS; the system role can write across schools for this small
    // audit-tracked action).
    const session = await getSession(request);
    if (!session) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const sysDb = getSystemClientFromEnv();
    await withUserContext(
      sysDb,
      session.schoolId,
      session.userId,
      async (tx) => {
        await tx
          .update(users)
          .set({ phoneVerifiedAt: new Date(), phone: parsed.data.phone })
          .where(eq(users.id, session.userId));
      },
    );
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'bad_intent' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

// Helper to build a system-role client for the phone-verified update.
// Same env resolution as auth.server.ts#getAuthDb.
function getSystemClientFromEnv(): Db {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('verify-phone: SYSTEM_DATABASE_URL not set');
  return getSystemClient(url).db;
}

export default function VerifyPhone() {
  const requestFetcher = useFetcher<{ ok?: boolean; phone?: string; error?: string }>();
  const confirmFetcher = useFetcher<{ ok?: boolean; error?: string; detail?: string }>();
  const [phone, setPhone] = useState('');

  const requestForm = useForm<PhoneRequestInput>({
    resolver: zodResolver(phoneRequestSchema),
  });
  const confirmForm = useForm<PhoneConfirmInput>({
    resolver: zodResolver(phoneConfirmSchema),
  });

  const csrf = csrfFormField();

  function onRequestSubmit(values: PhoneRequestInput) {
    setPhone(values.phone);
    const fd = new FormData();
    fd.append('intent', 'request');
    fd.append('phone', values.phone);
    fd.append(csrf.name, csrf.value);
    requestFetcher.submit(fd, { method: 'post' });
  }

  function onConfirmSubmit(values: PhoneConfirmInput) {
    const fd = new FormData();
    fd.append('intent', 'confirm');
    fd.append('phone', values.phone);
    fd.append('code', values.code);
    fd.append(csrf.name, csrf.value);
    confirmFetcher.submit(fd, { method: 'post' });
  }

  const codeRequested = requestFetcher.data?.ok ?? false;

  if (confirmFetcher.data?.ok) {
    return (
      <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
        <h1>Phone verified</h1>
        <p>Your phone number is now verified.</p>
        <p>
          <Link to="/app">Back to dashboard</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Verify your phone</h1>

      {!codeRequested && (
        <form onSubmit={requestForm.handleSubmit(onRequestSubmit)} noValidate>
          <input type="hidden" name={csrf.name} value={csrf.value} />
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="phone">Phone number (international format)</label>
            <input
              id="phone"
              type="tel"
              placeholder="+14165551234"
              {...requestForm.register('phone')}
              aria-invalid={requestForm.formState.errors.phone ? 'true' : undefined}
            />
            {requestForm.formState.errors.phone && (
              <p role="alert" style={{ color: '#b91c1c' }}>
                {requestForm.formState.errors.phone.message}
              </p>
            )}
          </div>
          <button type="submit" disabled={requestFetcher.state !== 'idle'}>
            {requestFetcher.state === 'idle' ? 'Send code' : 'Sending...'}
          </button>
        </form>
      )}

      {codeRequested && (
        <form onSubmit={confirmForm.handleSubmit(onConfirmSubmit)} noValidate>
          <input type="hidden" name={csrf.name} value={csrf.value} />
          <p>We sent a 6-digit code to {phone}. Enter it below.</p>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="code">Code</label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              {...confirmForm.register('code')}
              aria-invalid={confirmForm.formState.errors.code ? 'true' : undefined}
            />
            {confirmForm.formState.errors.code && (
              <p role="alert" style={{ color: '#b91c1c' }}>
                {confirmForm.formState.errors.code.message}
              </p>
            )}
          </div>
          {confirmFetcher.data?.error && (
            <p role="alert" style={{ color: '#b91c1c' }}>
              {confirmFetcher.data.detail ?? confirmFetcher.data.error}
            </p>
          )}
          <button type="submit" disabled={confirmFetcher.state !== 'idle'}>
            {confirmFetcher.state === 'idle' ? 'Verify' : 'Verifying...'}
          </button>
        </form>
      )}
    </main>
  );
}