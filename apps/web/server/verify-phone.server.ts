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

import { logger } from './logger.server';

/**
 * Send a 6-digit verification code to `phone` (E.164). Returns true on
 * accepted dispatch (not on actual delivery — Twilio Verify returns
 * "pending" until the user enters the code).
 *
 * In production this calls Twilio Verify v2. In dev (no creds) it logs
 * a fixed code so the developer can test the form without a real SMS.
 */
export async function sendVerificationCode(phone: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !serviceSid) {
    // Dev fallback — log a fixed code.
    logger.warn(
      { phone, code: '123456' },
      'verify-phone: TWILIO_VERIFY_SERVICE_SID not set; using dev code (123456). DO NOT ship to prod.',
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
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!sid || !token || !serviceSid) {
    // Dev fallback: accept the fixed code.
    return code === '123456';
  }

  // TODO(tier-2): wire Twilio Verify API call.
  logger.warn({ phone }, 'verify-phone: not implemented in Tier 1');
  return false;
}