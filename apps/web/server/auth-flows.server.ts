// apps/web/server/auth-flows.server.ts — stub for password reset +
// email/phone verification + magic link flows.
//
// All of these flows depend on email/SMS delivery (Resend, Twilio)
// which are mocked in this codebase (EMAIL_PROVIDER=mock,
// SMS_PROVIDER=mock). When the real providers are wired up,
// this module grows the actual implementations.
//
// What exists today:
//   - Token store: better_auth's `auth_verification` table (uuid PK,
//     identifier + value + expires_at). Already in the schema.
//   - Email sender: @edusupervise/email package (mock or resend).
//   - Password hasher: auth.server.ts#hashPassword (bcrypt cost 12).
//
// This stub returns safe defaults that make the route handlers
// compile + behave sanely: a "check your email" UI after forgot,
// a "set your password" UI on reset with token validation, etc.
// Real token lookup + delivery is left as the actual implementations.

import { logger } from './logger.server';

// ---------------------------------------------------------------------------
// Token primitives
// ---------------------------------------------------------------------------

/**
 * Generate a 32-byte base64url token. Used for password reset,
 * email verification, magic-link, phone OTP — anywhere we need
 * an opaque single-use credential.
 */
export function generateAuthToken(): string {
  const buf = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(buf);
  } else {
    // Node fallback (unused in the browser bundle; typescript
    // narrows when the bundle is server-only).
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(buf).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

export interface TokenValidationResult {
  ok: boolean;
  reason?: 'not_found' | 'expired' | 'used' | 'mismatch';
}

/**
 * Stub for `SELECT FROM auth_verification WHERE identifier=? AND value=?`.
 * Real implementation: open a transaction, mark `used=true` so the
 * token is single-use, return ok=true. For now: just pretend every
 * token is valid (the route handlers will return success UI and the
 * user can navigate to the next step).
 *
 * TODO when wiring real email/sms:
 *   1. Look up the token in auth_verification
 *   2. Check expires_at > now()
 *   3. Atomically mark as used
 *   4. Return ok=false with reason if any check fails
 */
export function validateAuthToken(
  _identifier: string,
  _token: string,
): TokenValidationResult {
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export interface ForgotResult {
  ok: boolean;
  /** Human-readable status: 'sent' | 'rate_limited' | 'invalid_email'. */
  status: string;
}

/**
 * Stub: pretend to send a password reset email.
 *
 * Real implementation:
 *   1. Look up the user by email (system role — pre-school lookup)
 *   2. Always return ok=true (don't leak whether email exists)
 *   3. Generate token, INSERT into auth_verification with 1h expiry
 *   4. Send email via @edusupervise/email with the magic link
 *   5. Rate-limit by IP (max 5 per hour)
 */
export async function requestPasswordReset(email: string): Promise<ForgotResult> {
  logger.info(
    { email, stub: true },
    'auth.forgot: stubbed — would send reset email in production',
  );
  return { ok: true, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Magic link
// ---------------------------------------------------------------------------

/**
 * Stub: pretend to send a magic link.
 */
export async function requestMagicLink(email: string): Promise<ForgotResult> {
  logger.info(
    { email, stub: true },
    'auth.magic: stubbed — would send magic link in production',
  );
  return { ok: true, status: 'sent' };
}

// ---------------------------------------------------------------------------
// Email + phone verification
// ---------------------------------------------------------------------------

/**
 * Stub: pretend to send a verification email.
 */
export async function requestEmailVerification(email: string): Promise<ForgotResult> {
  logger.info(
    { email, stub: true },
    'auth.verify_email: stubbed — would send verification email',
  );
  return { ok: true, status: 'sent' };
}

/**
 * Stub: pretend to send a verification SMS.
 */
export async function requestPhoneVerification(phone: string): Promise<ForgotResult> {
  logger.info(
    { phone, stub: true },
    'auth.verify_phone: stubbed — would send SMS code',
  );
  return { ok: true, status: 'sent' };
}

/**
 * Stub: mark an email as verified.
 * Real: UPDATE users SET email_verified_at = now() WHERE id = ?.
 */
export async function markEmailVerified(_userId: string): Promise<void> {
  logger.info({ userId: _userId, stub: true }, 'auth.verify_email: stubbed mark verified');
}

/**
 * Stub: mark a phone as verified.
 */
export async function markPhoneVerified(_userId: string): Promise<void> {
  logger.info({ userId: _userId, stub: true }, 'auth.verify_phone: stubbed mark verified');
}