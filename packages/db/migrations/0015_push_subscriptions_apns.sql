-- Migration 0015: extend push_subscriptions to support APNs (iOS app).
--
-- Phase 2 of the iOS App Store pipeline. The iOS app (built via Capacitor
-- in commit d196a8d) uses APNs for push notifications — WKWebView does
-- NOT support the Web Push API, so even though our app loads the same
-- web code as the browser, iOS users need a separate channel.
--
-- Schema changes:
--   1. Add `platform` column (default 'web' for existing rows).
--   2. Add APNs columns: apns_token, apns_bundle_id, apns_app_version.
--   3. Make VAPID columns nullable (only 'web' rows need them).
--   4. Replace the old unique-on-endpoint index with two non-partial
--      uniques (one per platform). Non-partial because Drizzle's
--      onConflictDoUpdate(target: [col,col,col]) emits
--      ON CONFLICT (cols) which doesn't match a partial unique index
--      (WHERE clause). The cross-platform invariant is enforced by the
--      field-required CHECK constraints below (web rows must have
--      endpoint+p256dh+auth; iOS rows must have apns_token).
--   5. Add a per-platform lookup index for cleanup / debug.
--
-- Forward-compat: when Apple ships native iOS Live Activities or other
-- APNs features, add columns here rather than ALTER TYPE. Don't introduce
-- a pgEnum for `platform` — the live DB uses CHECK constraints, not real
-- Postgres enums (see schema.ts comment).
--
-- Idempotent: each ALTER uses IF EXISTS / DO $$ guards. Re-runs no-op.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Add new columns. Defaults + NULLability set so existing rows are valid.
-- ---------------------------------------------------------------------------

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web';

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS apns_token text;

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS apns_bundle_id text;

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS apns_app_version text;

-- Loosen NOT NULL on the Web Push columns. APNs rows have NULLs here.
ALTER TABLE push_subscriptions ALTER COLUMN endpoint DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. CHECK constraint pinning `platform` to a known set. Mirrors the
--    pgEnum we declare in schema.ts (the live DB stores it as a CHECK).
-- ---------------------------------------------------------------------------

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_platform_check;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_platform_check
  CHECK (platform IN ('web', 'ios'));

-- Cross-platform NOT NULL invariant: web rows must have endpoint+p256dh+auth;
-- ios rows must have apns_token. Stored as two CHECK constraints.
ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_web_fields_required;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_web_fields_required
  CHECK (
    platform <> 'web' OR (
      endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL
    )
  );

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_ios_fields_required;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_ios_fields_required
  CHECK (
    platform <> 'ios' OR (
      apns_token IS NOT NULL AND apns_bundle_id IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Replace unique indexes. Non-partial on (school, user, endpoint_or_token)
--    to match Drizzle's onConflictDoUpdate target-array form. Cross-platform
--    collisions are prevented by the field-required CHECK constraints above.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS push_subscriptions_school_user_endpoint_unique;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_web_unique
  ON push_subscriptions (school_id, user_id, endpoint);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_ios_unique
  ON push_subscriptions (school_id, user_id, apns_token);

-- ---------------------------------------------------------------------------
-- 4. Add a platform-keyed lookup index for cleanup / debug.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_platform
  ON push_subscriptions (school_id, user_id, platform);

-- Drop the old "give me all subs for this user" — the new partial index
-- above is faster and platform-aware.
DROP INDEX IF EXISTS idx_push_subscriptions_user;

-- Restore the broader lookup the dispatcher needs ("give me ALL subs for
-- this user, regardless of platform") via a separate non-partial index.
-- The dispatcher reads every sub to fan-out a single notification across
-- both channels (Web Push + APNs).
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_all
  ON push_subscriptions (school_id, user_id);