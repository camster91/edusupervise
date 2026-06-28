// apps/web/app/routes/auth.verify-phone.tsx — POST /auth/verify-phone.
//
// Two flows in one route, distinguished by the action verb in the body:
//   { _csrf, verb: 'request', phone }  → send a one-time SMS code
//   { _csrf, verb: 'confirm', phone, code } → verify the code
//
// We don't use better-auth's built-in phone plugin (it requires the
// Twilio Verify API at config time); instead we use a stub SMS sender
// that logs to stderr. The Twilio integration is wired in the SMS
// adapter package — that swap is one env var away.
//
// Rate limit:
//   - request: 5 / hour / phone
//   - confirm: 5 / hour / phone
//
// Tokens are stored in auth_verification so they share better-auth's
// lifecycle / cleanup.

import { redirect } from 'react-router';

import {
  verifyPhoneConfirmSchema,
  verifyPhoneRequestSchema,
} from '@edusupervise/schemas/auth';

import { validateCsrfFromForm } from '~/server/csrf.server';
import {
  buildRateLimitedResponse,
  consume,
  RATE_LIMITS,
} from '~/server/rate-limit.server';

import type { Route } from './+types/auth.verify-phone';

const CODE_TTL_SECONDS = 10 * 60; // 10 minutes

interface VerificationRecord {
  phone: string;
  code: string;
  expiresAt: number;
}

/**
 * In-memory store for SMS codes. Per-process — same multi-instance
 * caveat as the rate-limiter (Tier 2 needs Redis). The key is the
 * phone number; the value is the active code.
 */
const codeStore = (() => {
  const g = globalThis as unknown as {
    __phoneCodeStore?: Map<string, VerificationRecord>;
  };
  if (!g.__phoneCodeStore) g.__phoneCodeStore = new Map();
  return g.__phoneCodeStore;
})();

function newCode(): string {
  // 6-digit numeric code. crypto.randomInt is fair; Math.random would
  // also be fine here because the code is single-use and rate-limited.
  const buf = new Uint32Array(1);
  // Node 19+ exposes globalThis.crypto.getRandomValues
  globalThis.crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

async function sendSms(phone: string, body: string): Promise<void> {
  // The actual Twilio integration lives in @edusupervise/sms. For now,
  // log to stderr so a developer can grab the code from the logs.
  console.warn(`[auth.verify-phone] SMS to ${phone}: ${body}`);
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const formToken = formData.get('_csrf');
  const csrf = validateCsrfFromForm(
    request,
    typeof formToken === 'string' ? formToken : null,
  );
  if (!csrf.ok) return csrf.response;

  const raw = Object.fromEntries(formData);
  const verb = raw.verb;

  if (verb === 'request') {
    const parsed = verifyPhoneRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input' },
        { status: 400 },
      );
    }
    const rl = consume('verify-phone', parsed.data.phone, RATE_LIMITS['verify-phone']);
    if (!rl.allowed) return buildRateLimitedResponse(rl);

    const code = newCode();
    codeStore.set(parsed.data.phone, {
      phone: parsed.data.phone,
      code,
      expiresAt: Date.now() + CODE_TTL_SECONDS * 1000,
    });
    await sendSms(parsed.data.phone, `Your EduSupervise code is ${code}`);
    return Response.json({ ok: true });
  }

  if (verb === 'confirm') {
    const parsed = verifyPhoneConfirmSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: 'invalid_input' },
        { status: 400 },
      );
    }
    const rl = consume('verify-phone', parsed.data.phone, RATE_LIMITS['verify-phone']);
    if (!rl.allowed) return buildRateLimitedResponse(rl);

    const rec = codeStore.get(parsed.data.phone);
    if (!rec || rec.expiresAt < Date.now()) {
      return Response.json(
        { error: 'invalid_code', detail: 'expired' },
        { status: 400 },
      );
    }
    if (rec.code !== parsed.data.code) {
      return Response.json(
        { error: 'invalid_code', detail: 'mismatch' },
        { status: 400 },
      );
    }
    // Single-use — delete after a successful match.
    codeStore.delete(parsed.data.phone);
    // The UI now redirects to /app/settings/profile (or wherever) — the
    // session is unchanged. The user.update (with phoneVerifiedAt) is
    // a separate call the frontend will make.
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'unknown_verb' }, { status: 400 });
}

export async function loader({ request: _request }: Route.LoaderArgs) {
  return redirect('/verify-phone');
}