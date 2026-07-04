// apps/web/server/verify-phone.server.ts — Twilio Verify integration.
//
// STUB for Tier 1. Real implementation calls Twilio Verify v2:
//   POST https://verify.twilio.com/v2/Services/{ServiceSid}/Verifications
//   POST https://verify.twilio.com/v2/Services/{ServiceSid}/VerificationCheck
//
// We split this out from verify-phone.tsx so the route file stays a thin
// form handler and the SDK calls + secrets management live in one
// place. The real Twilio Verify wiring lives in this file once
// TWILIO_ACCOUNT_SID + TWILIO_VERIFY_SERVICE_SID are present.
//
// In dev (no Twilio creds) we log the code so the developer can type
// it into the form. This mirrors the pattern in auth.server.ts
// (Resend fallback to logging).
//
// SECURITY (audit B2, 2026-07-04): the dev fallback previously accepted
// the fixed code 123456 in any environment, including production if
// the Twilio env vars were missing for any reason (deploy hiccup, secret
// rotation, typo). That was a full account-takeover path. The fix
// below gates the dev fallback on NODE_ENV !== 'production' so a
// production deploy with missing Twilio creds FAILS LOUDLY instead
// of silently accepting 123456.

import { logger } from './logger.server';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Assert Twilio Verify env vars are present in production. Throws
 * otherwise. The route handler catches the throw and returns 503 to
 * the client, so the failure is visible immediately rather than
 * silently bypassing phone verification.
 */
function requireTwilioCredsInProduction(): void {
  if (!IS_PRODUCTION) return;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token || !serviceSid) {
    throw new Error(
      'verify-phone: production requires TWILIO_ACCOUNT_SID + ' +
        'TWILIO_AUTH_TOKEN + TWILIO_VERIFY_SERVICE_SID. Refusing to ' +
        'fall back to dev code 123456 in production.',
    );
  }
}

/**
 * Send a 6-digit verification code to `phone` (E.164). Returns true on
 * accepted dispatch (not on actual delivery — Twilio Verify returns
 * "pending" until the user enters the code).
 *
 * In production this calls Twilio Verify v2. In dev (no creds) it logs
 * a fixed code so the developer can test the form without a real SMS.
 */
export async function sendVerificationCode(phone: string): Promise<boolean> {
  requireTwilioCredsInProduction();

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !serviceSid) {
    // Dev fallback — log a fixed code. Reachable only when NOT in
    // production (the requireTwilioCredsInProduction() guard above
    // throws first if NODE_ENV === 'production').
    logger.warn(
      { phone, code: '123456' },
      'verify-phone: TWILIO_VERIFY_SERVICE_SID not set; using dev code (123456) in non-prod.',
    );
    return true;
  }

  // TODO(tier-2): wire Twilio Verify API call.
  //   const url = `https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`;
  //   const body = new URLSearchParams({ To: phone, Channel: 'sms' });
  //   const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  //   const res = await fetch(url, {
  //     method: 'POST',
  //     headers: {
  //       Authorization: `Basic ${auth}`,
  //       'Content-Type': 'application/x-www-form-urlencoded',
  //     },
  //     body,
  //   });
  //   if (!res.ok) throw new Error(`twilio verify send failed: ${res.status}`);
  //   return true;

  logger.warn({ phone }, 'verify-phone: not implemented in Tier 1');
  return true;
}

/**
 * Verify a 6-digit code. Returns true if Twilio says it matches.
 */
export async function verifyCode(phone: string, code: string): Promise<boolean> {
  // SECURITY (audit B2): refuse to accept 123456 (or any code) in
  // production when Twilio creds are missing. The require guard runs
  // FIRST so a misconfigured production deploy cannot bypass the
  // check. In dev, the original 123456 fallback still works.
  requireTwilioCredsInProduction();

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !serviceSid) {
    // Dev fallback: accept the fixed code (NODE_ENV !== 'production').
    return code === '123456';
  }

  // TODO(tier-2): wire Twilio Verify API call.
  logger.warn({ phone }, 'verify-phone: not implemented in Tier 1');
  return false;
}