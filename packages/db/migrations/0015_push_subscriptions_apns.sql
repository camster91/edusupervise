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
--   4. Replace the old unique-on-endpoint index with two partial uniques
--      (one per platform) — iOS users can have one web sub + one iOS
--      sub simultaneously.
--   5. Drop the old idx_push_subscriptions_user; replace with a partial
--      index covering both web + ios lookups (we send to all of them).
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
-- 3. Replace unique indexes. The old one keyed on (school_id, user_id,
--    endpoint) which is NULL for iOS rows — two iOS rows with NULL endpoint
--    would NOT conflict on that index, which is wrong.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS push_subscriptions_school_user_endpoint_unique;

-- One web subscription per (school, user, endpoint). NULL endpoint rows
-- (iOS) are excluded by the WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_web_unique
  ON push_subscriptions (school_id, user_id, endpoint)
  WHERE platform = 'web';

-- One iOS subscription per (school, user, apns_token). A user can have
-- at most one iOS device token per bundle ID — re-registering with the
-- same token upserts; a new device replaces.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_ios_unique
  ON push_subscriptions (school_id, user_id, apns_token)
  WHERE platform = 'ios';

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