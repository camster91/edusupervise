-- Migration 0016: account deletion flow
--
-- Adds the data model for App Store guideline 5.1.1(v) compliance:
--   1. Soft-delete: pending_deletion_at on users
--   2. One-time confirmation token: account_deletion_tokens
--   3. Hard-delete: cron job (added in a follow-up commit) finds users
--      with pending_deletion_at < now() - 30 days and hard-deletes them.
--
-- User flow:
--   1. User visits /account/delete, enters their email
--   2. requestAccountDeletion(email) mints a 32-byte URL-safe token,
--      stores it in account_deletion_tokens with 7-day expiry, sends
--      Mailgun email with a confirmation link
--   3. User clicks the link, hits GET /account/delete/confirm?token=...
--   4. confirmAccountDeletion(token) validates the token (single-use,
--      not expired), sets users.pending_deletion_at = now() + 30 days,
--      marks the token used, and soft-deletes push_subscriptions
--   5. If the user is signed in and visits /account/cancel-deletion
--      within the 30 days, clear pending_deletion_at
--   6. The daily cron at 04:00 UTC hard-deletes any user with
--      pending_deletion_at < now() - 30 days, cascading to:
--      notifications, duties, coverage_requests, push_subscriptions,
--      audit_log entries for that user
--
-- This migration is idempotent (uses IF NOT EXISTS).

BEGIN;

-- 1. pending_deletion_at on users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_deletion_at TIMESTAMPTZ;

-- Index for the daily hard-delete cron
CREATE INDEX IF NOT EXISTS idx_users_pending_deletion_at
  ON users (pending_deletion_at)
  WHERE pending_deletion_at IS NOT NULL;

-- 2. account_deletion_tokens
--    Stores one-time tokens for the email confirmation step.
--    identifier is the email the user typed in the form (the looked-up
--    user's email may differ if the user mistyped; we bind to the
--    request-time email so a typo doesn't accidentally delete the wrong
--    user - the confirmation email goes to whatever was typed, and
--    the confirm route re-looks-up the user by the token's identifier
--    field, not by the URL parameter).
CREATE TABLE IF NOT EXISTS account_deletion_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- email the user typed in the form
  identifier TEXT NOT NULL,
  -- base64url-encoded 32 random bytes (43 chars)
  token_hash TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  -- optional: schoolId for the looked-up user at request time
  -- (lets us render the email with school name; never trusted for authz)
  school_id UUID REFERENCES schools(id) ON DELETE SET NULL
);

-- Index for token lookup by hash
CREATE INDEX IF NOT EXISTS idx_account_deletion_tokens_token_hash
  ON account_deletion_tokens (token_hash);

-- Index for the daily prune cron (drop unused tokens after 7 days)
CREATE INDEX IF NOT EXISTS idx_account_deletion_tokens_expires_at
  ON account_deletion_tokens (expires_at);

-- 3. RLS for account_deletion_tokens
--    The token table is accessed via getSystemClient() (BYPASSRLS) for
--    requestAccountDeletion and confirmAccountDeletion (the user is
--    anonymous at the request step - not signed in yet). Once the
--    token is consumed and the user is soft-deleted, future
--    confirmations on the same token are rejected (token is single-use).
ALTER TABLE account_deletion_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_tokens FORCE ROW LEVEL SECURITY;

-- No policies - all access goes through getSystemClient(). RLS forces any
-- accidental runtime-role query to return 0 rows (defense in depth).

-- 4. Grants (table-level privileges)
--    The runtime role needs SELECT/INSERT for the rate-limit check in
--    requestAccountDeletion (it returns 0 rows due to RLS, which is the
--    expected deny-by-default behavior). The system role needs full
--    CRUD so BYPASSRLS gives it the actual access. Without these
--    explicit grants the table is owner-only and every query fails
--    with "permission denied" before RLS even gets a chance to deny.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_deletion_tokens
  TO edusupervise_system, edusupervise_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public
  TO edusupervise_system, edusupervise_runtime;

-- 5. audit_log entry for the deletion request
--    (audit_log already exists from migration 0006; we just use it)
--    actions: 'account_deletion_confirmed' | 'account_deletion_cancelled'
--    | 'account_deletion_purged'
--    (no 'requested' event — the request step is unauthenticated and
--    we don't audit anonymous email submissions to avoid spam.)

COMMIT;
