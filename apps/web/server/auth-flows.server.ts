// apps/web/server/auth-flows.server.ts — token-mint/verify flows for
// password reset, magic link, email verification, phone verification.
//
// All four flows share the same shape:
//
//   1. A request step mints a single-use token, stores it in
//      `auth_verification` (identifier, value, expiresAt), and (in
//      production) sends it to the user via email or SMS.
//   2. A consume step looks up the token by value, checks the expiry,
//      performs the side effect (update password / mark verified /
//      mint session), then deletes the row to enforce single-use.
//
// Why we own this in one module:
//   - The token shape is the contract between the request and consume
//     endpoints. If the shape changes (e.g. add a `school_id` column
//     so consume is RLS-aware), every flow changes the same way.
//   - Email / SMS dispatch is centralised so a single env-var change
//     (e.g. switching from Resend to Postmark) ripples to all flows.
//   - Tests can mock `mintToken` / `consumeToken` without spinning up
//     a full HTTP server.
//
// Token format: 32 random bytes hex-encoded. Identifiers are namespaced
// (`reset-password:<email>`, `magic-link:<email>`, `verify-email:<userId>`,
// `phone-verify:<phone>`) so the `auth_verification` table is a single
// store for every kind of one-time token better-auth would have used.

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import {
  authVerification,
  users,
  type Db,
} from '@edusupervise/db';

import { logger } from './logger.server';

// ---------------------------------------------------------------------------
// Namespaces — used as the `identifier` column on auth_verification.
// ---------------------------------------------------------------------------

export const TOKEN_KIND = {
  RESET_PASSWORD: 'reset-password',
  MAGIC_LINK: 'magic-link',
  VERIFY_EMAIL: 'verify-email',
  PHONE_VERIFY: 'phone-verify',
} as const;
export type TokenKind = (typeof TOKEN_KIND)[keyof typeof TOKEN_KIND];

// TTLs per spec section 5.
const TTL_MS = {
  [TOKEN_KIND.RESET_PASSWORD]: 60 * 60 * 1000,        // 1 hour
  [TOKEN_KIND.MAGIC_LINK]:     5 * 60 * 1000,         // 5 minutes
  [TOKEN_KIND.VERIFY_EMAIL]:   60 * 60 * 1000,        // 1 hour
  [TOKEN_KIND.PHONE_VERIFY]:   5 * 60 * 1000,         // 5 minutes
} as const;

// Identifier builder — public so the routes + tests can predict
// what the row will look like for a given email / user / phone.
export function tokenIdentifier(kind: TokenKind, target: string): string {
  return `${kind}:${target.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mint a new one-time token. Returns the raw token (32-byte hex) —
 * routes include this in the link sent to the user. The DB row only
 * stores the HMAC of the token (see `tokenValue` below), not the raw
 * value, so a database leak doesn't grant account-takeover.
 *
 * Spec section 5: HMAC-SHA256, single-use, 1-hour TTL (5 min for
 * magic-link). We use HMAC for two reasons:
 *   1. Constant-time compare via timingSafeEqual in `consumeToken`.
 *   2. The DB row only carries a hash, never the raw token, so a
 *      SQLi / backup leak doesn't expose live tokens.
 */
export function mintToken(kind: TokenKind, target: string): {
  token: string;
  expiresAt: Date;
} {
  // 32 bytes = 256 bits. Plenty for a one-time token; collision
  // probability is ~10^-77 across a million tokens.
  const raw = randomBytes(32).toString('hex');
  return {
    token: raw,
    expiresAt: new Date(Date.now() + TTL_MS[kind]),
  };
}

export function hashToken(token: string): string {
  // Spec section 5: "HMAC-SHA256, 1-hour TTL, single-use". The HMAC
  // is keyed by SESSION_SECRET so an attacker with DB read access
  // can't pre-compute tokens for arbitrary identifiers.
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'auth-flows: SESSION_SECRET is missing or too short. Set a 32+ char random value.',
    );
  }
  return createHmac('sha256', secret).update(token).digest('hex');
}

/**
 * Persist a freshly-minted token. Returns the identifier + expiresAt
 * for the caller (used to build the email body / verification URL).
 *
 * If a row already exists for the same (kind, target), we REPLACE it
 * — clicking "forgot password" twice should issue a fresh token, not
 * leave the old one valid. This matches better-auth's behavior.
 */
export async function persistToken(
  db: Db,
  kind: TokenKind,
  target: string,
  token: string,
  expiresAt: Date,
): Promise<{ identifier: string; expiresAt: Date }> {
  const identifier = tokenIdentifier(kind, target);
  const value = hashToken(token);

  // Delete any existing row for this identifier (single-active-token
  // per target). Better-auth does the same: the most recent request
  // wins.
  await db
    .delete(authVerification)
    .where(eq(authVerification.identifier, identifier));

  await db.insert(authVerification).values({
    identifier,
    value,
    expiresAt,
  });

  return { identifier, expiresAt };
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

export interface ConsumeOk {
  ok: true;
  identifier: string;
}

export interface ConsumeErr {
  ok: false;
  reason: 'invalid_token' | 'expired';
}

export type ConsumeResult = ConsumeOk | ConsumeErr;

/**
 * Look up a token by its raw value + kind + target. Returns
 * `{ ok: true }` on success AND deletes the row (single-use). Returns
 * `{ ok: false, reason: ... }` if the token doesn't match, has
 * already been consumed, or has expired.
 *
 * The `target` is required to scope the lookup — without it, a
 * leaked token from one flow could be redeemed in another. The route
 * always knows the target (the email the user typed, the user id
 * from the link, etc.) and passes it explicitly.
 */
export async function consumeToken(
  db: Db,
  kind: TokenKind,
  target: string,
  token: string,
): Promise<ConsumeResult> {
  const identifier = tokenIdentifier(kind, target);
  const value = hashToken(token);

  // SELECT FOR UPDATE would be cleaner but postgres.js doesn't expose
  // it via drizzle; the unique constraint is on (identifier) so a
  // concurrent consume would race on the DELETE. Two simultaneous
  // consumes of the same token both pass the SELECT + verify step
  // and both attempt the DELETE; the second one's DELETE matches
  // zero rows, which we treat as "already consumed". This is good
  // enough for the small race window (a few ms between SELECT and
  // DELETE) and matches better-auth's behavior.
  const rows = await db
    .select()
    .from(authVerification)
    .where(eq(authVerification.identifier, identifier))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: 'invalid_token' };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    // Best-effort cleanup. If the row was already deleted by another
    // path, this is a no-op.
    await db
      .delete(authVerification)
      .where(eq(authVerification.identifier, identifier))
      .catch(() => undefined);
    return { ok: false, reason: 'expired' };
  }

  // Constant-time compare.
  if (!safeEqualHex(row.value, value)) {
    return { ok: false, reason: 'invalid_token' };
  }

  // Token is good — consume atomically. We delete the row only if it
  // still exists, so a concurrent consume can't both succeed.
  const deleted = await db
    .delete(authVerification)
    .where(and(
      eq(authVerification.identifier, identifier),
      eq(authVerification.value, value),
    ))
    .returning({ id: authVerification.id });

  if (deleted.length === 0) {
    return { ok: false, reason: 'invalid_token' };
  }
  return { ok: true, identifier };
}

// ---------------------------------------------------------------------------
// Email / SMS dispatch (log in dev, real provider in prod)
// ---------------------------------------------------------------------------

/**
 * Send the email for a given flow. In dev (no RESEND_API_KEY) we log
 * the link to stderr so the developer can paste it into a browser.
 * Returns the full URL we would have emailed — useful for tests that
 * want to exercise the consume step without intercepting an email.
 */
export async function dispatchAuthEmail(input: {
  kind: TokenKind;
  to: string;
  url: string;
  appUrl: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESEND_FROM_EMAIL ?? 'noreply@edusupervise.ashbi.ca';
  const subject =
    input.kind === TOKEN_KIND.RESET_PASSWORD
      ? 'Reset your EduSupervise password'
      : input.kind === TOKEN_KIND.MAGIC_LINK
        ? 'Your EduSupervise sign-in link'
        : input.kind === TOKEN_KIND.VERIFY_EMAIL
          ? 'Verify your EduSupervise email'
          : 'EduSupervise verification';
  const body = buildEmailBody(input.kind, input.url);

  if (!apiKey) {
    logger.warn(
      { kind: input.kind, to: input.to, url: input.url },
      'auth-flows: RESEND_API_KEY not set; auth email logged above',
    );
    return;
  }

  // Lazy import to keep resend out of the dev / test bundle when not
  // configured.
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  await resend.emails.send({
    from,
    to: input.to,
    subject,
    html: body,
  });
}

function buildEmailBody(kind: TokenKind, url: string): string {
  const tail = url.split('#')[1] ?? '';
  const tokenParam = tail.startsWith('token=') ? tail.slice('token='.length) : '';
  const verifyUrl = `${url.split('#')[0]}#token=${encodeURIComponent(tokenParam)}`;
  switch (kind) {
    case TOKEN_KIND.RESET_PASSWORD:
      return `<p>Someone (hopefully you) requested a password reset for your EduSupervise account.</p>
<p>Open <a href="${verifyUrl}">this link</a> to choose a new password. The link expires in 1 hour.</p>
<p>If you didn't request this, ignore this email.</p>`;
    case TOKEN_KIND.MAGIC_LINK:
      return `<p>Click <a href="${verifyUrl}">this link</a> to sign in to EduSupervise. The link expires in 5 minutes.</p>
<p>If you didn't request this, ignore this email.</p>`;
    case TOKEN_KIND.VERIFY_EMAIL:
      return `<p>Welcome to EduSupervise. Click <a href="${verifyUrl}">this link</a> to verify your email. The link expires in 1 hour.</p>`;
    default:
      return `<p>Open <a href="${verifyUrl}">this link</a> to continue.</p>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time string compare for hex values of equal length. We
 * can't use `crypto.timingSafeEqual` directly on the hex strings
 * because they may be of different lengths if the attacker sends a
 * truncated token — we'd get a crash. Pad / truncate to the same
 * length so the comparison is constant-time and never throws.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Allocate a buffer of the same length so timing matches a
    // same-length pair (avoids the "length difference" timing
    // side-channel).
    const padded = Buffer.alloc(a.length);
    Buffer.from(b).copy(padded, 0, 0, Math.min(a.length, b.length));
    return timingSafeEqual(Buffer.from(a), padded);
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Best-effort cleanup of expired verification rows. Call from a
 * background job (Tier 2) or the consume path on cache-miss. The
 * spec doesn't require this; better-auth has the same TODO.
 */
export async function sweepExpiredTokens(db: Db): Promise<number> {
  const result = await db
    .delete(authVerification)
    .where(lt(authVerification.expiresAt, new Date()))
    .returning({ id: authVerification.id });
  return result.length;
}

// Re-export a `users` row lookup helper for the verify-email flow —
// the route doesn't know which user a token verifies, so it needs a
// one-liner that reads `email_verified_at` for a given email.
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; email: string; emailVerifiedAt: Date | null } | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}