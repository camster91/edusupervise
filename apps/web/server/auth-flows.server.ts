// apps/web/server/auth-flows.server.ts — password reset +
// email/phone verification + magic link flows.
//
// All of these flows depend on email/SMS delivery (Resend, Twilio)
// which are mocked in this codebase (EMAIL_PROVIDER=mock,
// SMS_PROVIDER=mock). When the real providers are wired up,
// the stub functions below grow into real implementations.
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
// Token kind constants
// ---------------------------------------------------------------------------

/**
 * Token kinds. The auth_verification table does NOT have a `kind` column —
 * callers (password reset, magic link, verify-email) look up by
 * (identifier, value) and the route context implicitly determines kind.
 * This constant is kept so callers + log lines can speak a common
 * vocabulary, but consumeToken does not filter by it.
 */
export const TOKEN_KIND = {
  VERIFY_EMAIL: 'verify_email',
  VERIFY_PHONE: 'verify_phone',
  PASSWORD_RESET: 'password_reset',
  MAGIC_LINK: 'magic_link',
} as const;

export type TokenKind = (typeof TOKEN_KIND)[keyof typeof TOKEN_KIND];

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
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(buf).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token mint / persist / consume
// ---------------------------------------------------------------------------

/**
 * Mint a fresh token + its expiry. The expiry is configurable
 * (default 1h) and returned alongside the token so the caller can
 * persist them atomically.
 */
export function mintToken(
  _kind: TokenKind,
  _identifier: string,
  ttlMs: number = 60 * 60 * 1000,
): { token: string; expiresAt: Date } {
  return {
    token: generateAuthToken(),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

/**
 * Persist a freshly-minted token to auth_verification.
 *
 * Real implementation: INSERT INTO auth_verification (id, identifier,
 * value, expires_at) VALUES (gen_random_uuid(), ?, ?, ?).
 *
 * Stub: just log it. The schema is the real source of truth, and
 * the route handlers only read the return value.
 */
export async function persistToken(
  _db: unknown,
  _kind: TokenKind,
  _identifier: string,
  _token: string,
  _expiresAt: Date,
): Promise<void> {
  logger.info(
    { kind: _kind, identifier: _identifier, stub: true },
    'auth-flows.persistToken: stubbed — would INSERT INTO auth_verification',
  );
}

/**
 * Look up a token in auth_verification, mark it as used atomically.
 *
 * Real implementation:
 *   BEGIN;
 *   SELECT * FROM auth_verification WHERE identifier=? AND value=? AND expires_at > now() FOR UPDATE;
 *   UPDATE auth_verification SET consumed_at = now() WHERE id = ?;
 *   COMMIT;
 *
 * Stub: return ok=true unconditionally.
 */
export async function consumeToken(
  db: unknown,
  _kind: TokenKind,
  identifier: string,
  token: string,
): Promise<TokenValidationResult> {
  // The auth_verification table is keyed on (identifier, value). The kind
  // parameter is carried by the caller for log clarity but is NOT
  // stored on the row — multiple kinds can share the same identifier
  // (e.g. a user verifying email AND requesting a password reset) and
  // the token value is unique per call. One-shot semantics: the row
  // is DELETEd on success so a leaked token cannot be replayed.
  //
  // The db param is the Drizzle client returned by getSystemClient() in
  // the caller (reset.tsx, auth.magic.tsx, verify-email.tsx). It is
  // typed as `unknown` here because the auth-flows module deliberately
  // stays decoupled from the db package's typed surface — it only
  // needs the small set of query methods that match better_auth's
  // auth_verification contract.
  const drizzleDb = db as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => {
        where: (...conds: unknown[]) => {
          limit: (n: number) => Promise<{ id: string; expiresAt: Date }[]>;
        };
      };
    };
    delete: (...args: unknown[]) => {
      where: (...conds: unknown[]) => Promise<unknown>;
    };
  };
  // Lazy import keeps the typecheck in this module decoupled from
  // the @edusupervise/db build (avoids the stale dist + this file's
  // type errors round-tripping during dev).
  const { authVerification } = await import('@edusupervise/db');
  const { and, eq, gt } = await import('drizzle-orm');
  const now = new Date();
  try {
    // 1. Find a non-expired row matching identifier + value
    const rows = await drizzleDb
      .select({ id: authVerification.id, expiresAt: authVerification.expiresAt })
      .from(authVerification)
      .where(
        and(
          eq(authVerification.identifier, identifier),
          eq(authVerification.value, token),
          gt(authVerification.expiresAt, now),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      // Could be not_found, expired, or mismatch — all three are "the
      // token is not valid right now" from the caller's perspective.
      // The single-shot DELETE pattern means used tokens also return
      // not_found. We do NOT distinguish in the response (avoids
      // token enumeration / timing oracles).
      logger.info(
        { kind: _kind, identifier },
        'auth-flows.consumeToken: token not found or expired',
      );
      return { ok: false, reason: 'not_found' };
    }
    // 2. One-shot: delete the row so the same token can't be reused.
    await drizzleDb
      .delete(authVerification)
      .where(
        and(
          eq(authVerification.id, row.id),
          // Belt-and-suspenders: only delete if still not expired.
          // In practice the just-read row IS the row, but this guards
          // against a race where expiresAt is updated between the
          // SELECT and the DELETE.
          gt(authVerification.expiresAt, new Date()),
        ),
      );
    logger.info(
      { kind: _kind, identifier, rowId: row.id },
      'auth-flows.consumeToken: token consumed',
    );
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, kind: _kind, identifier },
      'auth-flows.consumeToken: DB error',
    );
    return { ok: false, reason: 'not_found' };
  }
}

// ---------------------------------------------------------------------------
// User lookup
// ---------------------------------------------------------------------------

/**
 * Look up a user by email via the system-role client (BYPASSRLS,
 * pre-school). Returns undefined if not found.
 *
 * Real implementation: SELECT id, email, school_id, role FROM users
 * WHERE email = ? LIMIT 1.
 *
 * Stub: returns undefined. Route handlers that depend on this
 * (e.g. verify-email's auto-sign-in path) gracefully degrade.
 */
export async function findUserByEmail(
  _db: unknown,
  email: string,
): Promise<{ id: string; email: string } | undefined> {
  logger.info(
    { email, stub: true },
    'auth-flows.findUserByEmail: stubbed — would SELECT FROM users',
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Result of a one-shot token consumption. `ok=true` means the token was
 * valid (matched identifier + value + not-expired) and has been deleted
 * from auth_verification. `ok=false` means the caller should treat the
 * token as invalid (could be not_found / expired / used — we don't
 * distinguish in the response to avoid token-enumeration oracles).
 */
export interface TokenValidationResult {
  ok: boolean;
  reason?: 'not_found' | 'expired' | 'used' | 'mismatch';
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
 * Dispatch a token-bearing email (password reset, magic link,
 * email verify) to the right provider. Used by forgot.tsx +
 * auth.magic.tsx.
 *
 * Real implementation: switch on kind → route to @edusupervise/email
 * or @edusupervise/sms (Resend or Twilio). Today: log + return ok.
 */
export interface DispatchEmailOptions {
  kind: TokenKind;
  to: string;
  url: string;
  appUrl?: string;
}

/**
 * Stub send of an auth-flow email (password reset / magic link /
 * verify). Real implementation will route through @edusupervise/email
 * (Resend or Twilio). Today: log + return ok.
 */
export async function dispatchAuthEmail(
  options: DispatchEmailOptions,
): Promise<ForgotResult> {
  logger.info(
    { kind: options.kind, to: options.to, stub: true, hasUrl: !!options.url },
    'auth-flows.dispatchAuthEmail: stubbed — would send via Resend/Twilio',
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

// ---------------------------------------------------------------------------
// High-level helpers (used by signup, admin-invite, etc.)
// ---------------------------------------------------------------------------

/**
 * Issue an email-verification token + the URL the user clicks.
 * Used by the signup route and admin-invite flow.
 *
 * Real implementation:
 *   1. Look up the user (system role, pre-school)
 *   2. Mint a 1h token
 *   3. Persist to auth_verification
 *   4. Build `${APP_URL}/verify-email?auto=1#token=...&email=...`
 *   5. Send via @edusupervise/email
 *
 * Stub: returns the URL pointing at a no-op verify-email page.
 * The token isn't real — but the route handler that consumes
 * the URL is itself a stub, so the flow degrades to "you can sign
 * in" with no real verification.
 */
export async function sendEmailVerification(
  email: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  logger.info(
    { email, stub: true },
    'auth-flows.sendEmailVerification: stubbed — would mint + email link',
  );
  const appUrl = process.env.APP_URL ?? 'http://localhost:3011';
  return {
    ok: true,
    url: `${appUrl}/verify-email?auto=1#token=stub&email=${encodeURIComponent(email)}`,
  };
}