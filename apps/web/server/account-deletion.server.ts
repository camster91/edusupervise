// server/account-deletion.server.ts
//
// App Store guideline 5.1.1(v) account-deletion flow.
//
// User flow:
//   1. /account/delete  — user enters their email
//   2. requestAccountDeletion(email) mints a 32-byte URL-safe token,
//      stores the HASH in account_deletion_tokens with 7-day expiry,
//      sends a Mailgun email with a confirmation link containing the
//      raw token (one-time, never stored unhashed).
//   3. /account/delete/confirm?token=...  — user clicks the link
//   4. confirmAccountDeletion(token) validates the token (single-use,
//      not expired), sets users.pending_deletion_at = now() + 30 days,
//      marks the token used, soft-deletes the user's push
//      subscriptions, fires an audit_log entry.
//   5. (If signed in) /account/cancel-deletion  — clears
//      pending_deletion_at; the 30-day grace period is reset.
//   6. The daily cron at /root/edusupervise-secrets/daily-account-deletion-purge.sh
//      hard-deletes any user with pending_deletion_at < now(),
//      cascading to their notifications, duties, coverage_requests,
//      push_subscriptions, and audit_log entries.
//
// Security model:
//   - All DB access goes through getSystemClient() (BYPASSRLS) because
//     the request step is unauthenticated (no session yet). The token
//     table has RLS+FORCE with no policies, so the runtime role is
//     row-level denied even with SELECT/INSERT/UPDATE/DELETE granted
//     at the table level — defense in depth.
//   - The token's `identifier` field is the email the user TYPED. The
//     confirm step re-looks-up the user by that exact email. A typo
//     won't delete the wrong user (the typo'd email gets the
//     confirmation link; the user just doesn't see it).
//   - Tokens are stored as SHA-256 hashes, not raw. The raw token is
//     only in the email and the confirmation URL.
//   - Tokens are single-use (used_at is set on confirm).
//   - Tokens expire in 7 days (long enough for slow delivery,
//     short enough that abandoned requests don't pile up).

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getSystemClient } from '@edusupervise/db';
import { sendEmail } from '@edusupervise/email';
import { logger } from './logger.server.js';

const log = logger.child({ module: 'account-deletion' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days
const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const BASE_URL = process.env.APP_URL ?? 'https://edusupervise.ashbi.ca';
const SYSTEM_URL = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequestResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; error: 'invalid_email' | 'rate_limited' | 'no_such_user' };

export type ConfirmResult =
  | { ok: true; deletionAt: Date }
  | { ok: false; error: 'invalid_token' | 'expired_token' | 'already_used' };

export type CancelResult =
  | { ok: true }
  | { ok: false; error: 'no_pending_deletion' };

// ---------------------------------------------------------------------------
// Result-shape helper
// ---------------------------------------------------------------------------

/**
 * `db.execute(sql\`...\`)` returns either an Array<T> directly (when
 * drizzle/postgres.js resolves it as the rowset) or `{ rows: T[] }`
 * depending on the call path. Normalize both shapes into T[].
 */
function asRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | null | undefined;
  return maybe?.rows ?? [];
}

// ---------------------------------------------------------------------------
// requestAccountDeletion
// ---------------------------------------------------------------------------

/**
 * Mint a one-time token, store the hash + email, send Mailgun email.
 * Returns the raw token (only ever in memory + the email + the URL).
 *
 * If the email is not in the users table, the function still returns
 * ok: true (no enumeration of which emails are registered). The token
 * is stored but unused; the cron prunes it after 7 days.
 */
export async function requestAccountDeletion(email: string): Promise<RequestResult> {
  const normalized = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!SYSTEM_URL) {
    throw new Error('account-deletion: SYSTEM_DATABASE_URL or DATABASE_URL required');
  }

  const { db, close } = getSystemClient(SYSTEM_URL);
  try {
    // Find the user (BYPASSRLS) for the email + school context for the
    // confirmation email. Don't bail if user is missing - we still send
    // an email to avoid enumerating registered emails.
    const userRows = asRows<{
      id: string;
      school_id: string | null;
      name: string | null;
      school_name: string | null;
    }>(await db.execute(sql`
      SELECT u.id, u.school_id, u.name, s.name AS school_name
      FROM users u
      LEFT JOIN schools s ON s.id = u.school_id
      WHERE u.email = ${normalized}
        AND u.pending_deletion_at IS NULL
      ORDER BY u.created_at ASC
      LIMIT 1
    `));
    const userRow = userRows[0];
    const userId: string | null = userRow?.id ?? null;
    const schoolId: string | null = userRow?.school_id ?? null;
    const schoolName: string | null = userRow?.school_name ?? null;
    const userName: string | null = userRow?.name ?? null;

    // Rate limit: at most 3 pending tokens per email in 24h
    const rateRows = asRows<{ n: number }>(await db.execute(sql`
      SELECT count(*)::int AS n
      FROM account_deletion_tokens
      WHERE identifier = ${normalized}
        AND requested_at > now() - interval '24 hours'
        AND used_at IS NULL
    `));
    const recentCount = rateRows[0]?.n ?? 0;
    if (recentCount >= 3) {
      log.warn({ email: normalized, recentCount }, 'account-deletion: rate limit hit');
      return { ok: false, error: 'rate_limited' };
    }

    // Mint a 32-byte URL-safe token
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // Store the hash + identifier (BYPASSRLS)
    await db.execute(sql`
      INSERT INTO account_deletion_tokens
        (identifier, token_hash, expires_at, school_id)
      VALUES
        (${normalized}, ${tokenHash}, ${expiresAt.toISOString()}, ${schoolId})
    `);

    // Send the email
    const confirmUrl = `${BASE_URL}/account/delete/confirm?token=${rawToken}`;
    const sent = await sendEmail({
      to: normalized,
      subject: 'Confirm your EduSupervise account deletion',
      body: [
        `Hi${userName ? ` ${userName}` : ''},`,
        '',
        'You (or someone using your email) requested permanent deletion of your',
        'EduSupervise account' + (schoolName ? ` at ${schoolName}` : '') + '.',
        '',
        'Click the link below within 7 days to confirm:',
        '',
        confirmUrl,
        '',
        'After confirmation, your account is soft-deleted for 30 days. During',
        'this grace period you can cancel the deletion by signing in and',
        'visiting Settings > Account > Cancel deletion.',
        '',
        "If you didn't request this, you can ignore this email and the request",
        'will expire automatically in 7 days.',
        '',
        '- EduSupervise',
      ].join('\n'),
    });

    log.info({
      email: normalized,
      userId,
      schoolId,
      providerId: sent.providerId,
      expiresAt: expiresAt.toISOString(),
    }, 'account-deletion: token issued + email sent');

    return { ok: true, expiresAt };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// confirmAccountDeletion
// ---------------------------------------------------------------------------

/**
 * Validate the raw token from the email link, set pending_deletion_at
 * to now() + 30 days, mark the token used, soft-delete push
 * subscriptions, fire audit_log entry.
 *
 * Idempotent: if the token is already used, returns 'already_used' (not
 * 'invalid_token') so the user gets a clear message if they double-click.
 */
export async function confirmAccountDeletion(rawToken: string): Promise<ConfirmResult> {
  if (typeof rawToken !== 'string' || rawToken.length < 16) {
    return { ok: false, error: 'invalid_token' };
  }
  if (!SYSTEM_URL) {
    throw new Error('account-deletion: SYSTEM_DATABASE_URL or DATABASE_URL required');
  }

  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const { db, close } = getSystemClient(SYSTEM_URL);
  try {
    // Look up the token (BYPASSRLS)
    const rows = asRows<{
      id: string;
      identifier: string;
      expires_at: string;
      used_at: string | null;
      school_id: string | null;
    }>(await db.execute(sql`
      SELECT id, identifier, expires_at, used_at, school_id
      FROM account_deletion_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `));
    const row = rows[0];
    if (!row) {
      log.warn({ tokenHash: tokenHash.slice(0, 12) }, 'account-deletion: invalid token');
      return { ok: false, error: 'invalid_token' };
    }
    if (row.used_at) {
      log.info({ tokenId: row.id }, 'account-deletion: token already used');
      return { ok: false, error: 'already_used' };
    }
    if (new Date(row.expires_at) < new Date()) {
      log.info({ tokenId: row.id }, 'account-deletion: token expired');
      return { ok: false, error: 'expired_token' };
    }

    // Look up the user by the email the request was made for
    const userRows = asRows<{ id: string; school_id: string | null }>(await db.execute(sql`
      SELECT id, school_id FROM users WHERE email = ${row.identifier} LIMIT 1
    `));
    const userRow = userRows[0];
    if (!userRow) {
      // User was deleted between request and confirm. Mark the token used
      // anyway to prevent retries, and bail.
      await db.execute(sql`
        UPDATE account_deletion_tokens
        SET used_at = now()
        WHERE id = ${row.id}
      `);
      log.warn({ identifier: row.identifier }, 'account-deletion: user gone before confirm');
      return { ok: false, error: 'invalid_token' };
    }

    const deletionAt = new Date(Date.now() + GRACE_PERIOD_MS);

    // Soft-delete: set pending_deletion_at + mark token used + soft-delete
    // push subscriptions (push tokens must be deleted on app uninstall
    // per Apple Push Notification rules; we delete on soft-delete so the
    // user stops getting notifications immediately).
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE users
        SET pending_deletion_at = ${deletionAt.toISOString()},
            is_active = false,
            updated_at = now()
        WHERE id = ${userRow.id}
      `);
      await tx.execute(sql`
        UPDATE account_deletion_tokens
        SET used_at = now()
        WHERE id = ${row.id}
      `);
      // Soft-delete push subscriptions
      await tx.execute(sql`
        DELETE FROM push_subscriptions WHERE user_id = ${userRow.id}
      `);
      // Audit log entry (use real audit_log schema: action/targetType/
      // targetId/metadata; school_id is NOT NULL, so we skip the audit
      // row when there is no school context — should not happen since
      // we only get here after looking up the user by email). Cast
      // every bare $N parameter explicitly:
      //   - ::uuid for FK columns (drizzle can't infer UUID type)
      //   - ::text for jsonb_build_object string args (the values get
      //     stored as JSONB strings anyway, but bare text parameters
      //     confuse Postgres' type inference inside jsonb_build_object
      //     and it throws "could not determine data type of parameter
      //     $N" at PREPARE time).
      if (userRow.school_id) {
        await tx.execute(sql`
          INSERT INTO audit_log (school_id, user_id, action, target_type, target_id, metadata)
          VALUES (
            ${userRow.school_id}::uuid,
            ${userRow.id}::uuid,
            'account_deletion_confirmed'::text,
            'user'::text,
            ${userRow.id}::uuid,
            jsonb_build_object(
              'grace_period_days', 30::int,
              'deletion_at', ${deletionAt.toISOString()}::text,
              'token_id', ${row.id}::uuid
            )
          )
        `);
      }
    });

    log.info({
      userId: userRow.id,
      schoolId: userRow.school_id,
      deletionAt: deletionAt.toISOString(),
    }, 'account-deletion: confirmed; user soft-deleted with 30-day grace period');

    return { ok: true, deletionAt };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// cancelAccountDeletion
// ---------------------------------------------------------------------------

/**
 * Cancel a pending deletion. Scoped to the session's user id, not
 * by email. Used by the /account/cancel-deletion route.
 */
export async function cancelAccountDeletion(userId: string): Promise<CancelResult> {
  if (!userId) return { ok: false, error: 'no_pending_deletion' };
  if (!SYSTEM_URL) {
    throw new Error('account-deletion: SYSTEM_DATABASE_URL or DATABASE_URL required');
  }

  const { db, close } = getSystemClient(SYSTEM_URL);
  try {
    const rows = asRows<{ id: string; school_id: string | null }>(await db.execute(sql`
      UPDATE users
      SET pending_deletion_at = NULL, is_active = true, updated_at = now()
      WHERE id = ${userId} AND pending_deletion_at IS NOT NULL
      RETURNING id, school_id
    `));
    if (rows.length === 0) {
      return { ok: false, error: 'no_pending_deletion' };
    }
    const schoolId = rows[0].school_id;

    // Audit log (skip if no school context; should not happen for
    // real users since users.school_id is NOT NULL). Cast all bare
    // parameters explicitly so Postgres can infer the type.
    if (schoolId) {
      await db.execute(sql`
        INSERT INTO audit_log (school_id, user_id, action, target_type, target_id, metadata)
        VALUES (
          ${schoolId}::uuid,
          ${userId}::uuid,
          'account_deletion_cancelled'::text,
          'user'::text,
          ${userId}::uuid,
          jsonb_build_object('cancelled_at', now()::text)
        )
      `);
    }

    log.info({ userId, schoolId }, 'account-deletion: cancellation processed; user reactivated');
    return { ok: true };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// purgeAccountDeletions  (cron entry point)
// ---------------------------------------------------------------------------

/**
 * Hard-delete all users with pending_deletion_at < now(). Cascades to
 * their notifications, duties, coverage_requests, push_subscriptions,
 * audit_log entries. Idempotent.
 *
 * Run by daily-account-deletion-purge.sh (in /root/edusupervise-secrets/).
 */
export async function purgeAccountDeletions(): Promise<{ purged: number }> {
  if (!SYSTEM_URL) {
    throw new Error('account-deletion: SYSTEM_DATABASE_URL or DATABASE_URL required');
  }

  const { db, close } = getSystemClient(SYSTEM_URL);
  try {
    // Find the user IDs to purge
    const userRows = asRows<{ id: string; school_id: string | null; email: string }>(
      await db.execute(sql`
        SELECT id, school_id, email
        FROM users
        WHERE pending_deletion_at IS NOT NULL
          AND pending_deletion_at < now()
      `),
    );
    if (userRows.length === 0) {
      return { purged: 0 };
    }

    let purged = 0;
    for (const user of userRows) {
      try {
        await db.transaction(async (tx) => {
          // Migration 0017 made the created_by FKs on
          // duties / coverage_events / duty_assignments CASCADE,
          // so the DELETE below cleans up everything in one shot.
          // (Notifications, push_subscriptions, reminder_log,
          // account_deletion_tokens, and audit_log all CASCADE
          // on user_id from earlier migrations.)
          await tx.execute(sql`DELETE FROM users WHERE id = ${user.id}::uuid`);
          // Audit log entry for the purge event. We use NULL
          // user_id because the user is now gone (the FK cascades,
          // and we want the audit row to survive the cascade).
          if (user.school_id) {
            await tx.execute(sql`
              INSERT INTO audit_log (school_id, user_id, action, target_type, target_id, metadata)
              VALUES (
                ${user.school_id}::uuid,
                NULL,
                'account_deletion_purged'::text,
                'user'::text,
                ${user.id}::uuid,
                jsonb_build_object(
                  'purged_user_email', ${user.email}::text,
                  'purged_at', now()::text
                )
              )
            `);
          }
        });
        purged += 1;
        log.info({ userId: user.id, schoolId: user.school_id }, 'account-deletion: user purged');
      } catch (err) {
        log.error({ err, userId: user.id }, 'account-deletion: purge failed for user');
      }
    }

    // Also prune expired unused tokens (older than 30 days past expiry)
    await db.execute(sql`
      DELETE FROM account_deletion_tokens
      WHERE used_at IS NULL
        AND expires_at < now() - interval '30 days'
    `);

    return { purged };
  } finally {
    await close();
  }
}
