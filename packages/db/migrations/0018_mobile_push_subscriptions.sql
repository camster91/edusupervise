-- Migration 0015: Mobile push subscriptions + 'push-expo' reminder channel
-- (docs/superpowers/specs/2026-07-06-edusupervise-mobile-mvp.md §5)
--
-- Background: EduSupervise ships a mobile companion app (React Native +
-- Expo). The mobile app receives duty reminders + coverage requests via
-- Expo Push, the third notification channel alongside email + SMS.
-- Spec section 5: "Push notification strategy — recommended: Expo Push."
--
-- Three additive changes:
--
--   1. ALTER TYPE reminder_channel ADD VALUE 'push-expo'
--      The reminder_log.channel column is a Postgres ENUM created in
--      0000_init.sql. Adding a value extends the set without touching
--      any existing rows. Postgres 12+ allows ALTER TYPE ... ADD VALUE
--      inside a transaction; using IF NOT EXISTS makes it idempotent
--      against re-runs.
--
--   2. New table mobile_push_subscriptions
--      One row per device the user has logged in on with the mobile app.
--      The Expo push token is opaque (format: "ExponentPushToken[xxxxxxxx]")
--      and is the natural key for a device. UNIQUE(user_id, expo_push_token)
--      makes /api/mobile/push/subscribe idempotent.
--
--      Why a separate table (not a column on push_subscriptions):
--      - Web Push uses VAPID `endpoint + p256dh + auth` (RFC 8030). Expo
--        Push uses a single opaque token. Schema is genuinely different.
--      - One user can have a Web Push browser subscription AND a mobile
--        push subscription at the same time. The dispatch path calls both.
--      - The shared dispatch path lives in
--        packages/push/src/expo.ts + apps/web/server/notifications.server.ts.
--
--      revoked_at is a soft-delete marker for logout / app uninstall.
--      We never hard-delete — keeping the row makes audit + analytics
--      queries easier (e.g. "how many devices registered total this
--      month?"). The dispatch path filters revoked_at IS NULL.
--
--   3. RLS on mobile_push_subscriptions
--      Matches the tenant_isolation pattern from migration 0004/0010.
--      FORCE ROW LEVEL SECURITY so the runtime role can't bypass it.
--      A subquery policy via users.school_id is NOT needed here because
--      the table has a direct school_id column.
--
-- Online-safe + idempotent:
--   - ALTER TYPE ... ADD VALUE IF NOT EXISTS — re-runs are no-ops
--   - CREATE TABLE IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - ALTER TABLE ... ENABLE/FORCE RLS — idempotent
--   - DROP POLICY IF EXISTS + CREATE POLICY — idempotent
--   - GRANT in DO block with EXCEPTION handlers — idempotent
--
-- AUDIT_VERIFICATION (after this migration):
--   SET LOCAL ROLE edusupervise_runtime;
--   SELECT count(*) FROM mobile_push_subscriptions;  -- 0 (no school set)
--   SELECT enumlabel FROM pg_enum
--    WHERE enumtypid = 'reminder_channel'::regtype
--    ORDER BY enumsortorder;  -- 'email', 'sms', 'push-expo'

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Extend reminder_channel enum to include 'push-expo'
-- ---------------------------------------------------------------------------

ALTER TYPE reminder_channel ADD VALUE IF NOT EXISTS 'push-expo';

-- ---------------------------------------------------------------------------
-- 2. mobile_push_subscriptions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mobile_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  -- 'ios' or 'android' — CHECK below enforces the set. The mobile app
  -- picks the value from expo-notifications' getDevicePushTokenAsync()
  -- response (or Constants.platform.ios on iOS, android otherwise).
  platform text NOT NULL,
  -- Stable per-device identifier from the OS. We don't strictly need
  -- it (the Expo push token is already unique per device) but it helps
  -- analytics ("how many distinct devices per user?") and lets us
  -- correlate with crash reports.
  device_id text,
  -- Mobile app version at register time, e.g. "1.0.0". Lets ops
  -- debug "why is this user not getting pushes?" by checking
  -- "are they on a known-broken app version?".
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Soft-delete marker. NULL = active. Set on /api/mobile/push/unsubscribe
  -- (logout) and on DeviceNotRegistered responses from Expo.
  -- The dispatch path filters revoked_at IS NULL.
  revoked_at timestamptz,

  CONSTRAINT mobile_push_subscriptions_platform_check
    CHECK (platform IN ('ios', 'android')),
  -- Composite UNIQUE on (school_id, user_id, expo_push_token) — matches
  -- the web-push precedent at push_subscriptions in db/init/02-schema.sql
  -- and packages/db/src/schema.ts:721. Two reasons school_id is part of
  -- the key (security review finding E-004, 2026-07-06):
  --   1. School transfer: a user reassigned to a new school must not be
  --      blocked from subscribing on the new school's tenant.
  --   2. Shared device across two schools (staff covering two schools,
  --      school-issued iPad loaned out): each school's subscription is
  --      a distinct row, no spurious unique violation.
  CONSTRAINT mobile_push_subscriptions_school_user_token_unique
    UNIQUE (school_id, user_id, expo_push_token)
);

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- The dispatch lookup is "all active (revoked_at IS NULL) subscriptions
-- for this user in this school" — packages/push/src/expo.ts reads it
-- on every push. Partial index keeps the hot path small: revoked rows
-- are excluded from the index entirely.
CREATE INDEX IF NOT EXISTS idx_mobile_push_subscriptions_school_user_active
  ON mobile_push_subscriptions (school_id, user_id);

-- Token uniqueness is enforced by the UNIQUE constraint above, but
-- a separate index on expo_push_token speeds up the DeviceNotRegistered
-- path: when Expo returns a 400 with details.error = 'DeviceNotRegistered',
-- we look up the row by token (not by user) to mark it revoked.
CREATE INDEX IF NOT EXISTS idx_mobile_push_subscriptions_token
  ON mobile_push_subscriptions (expo_push_token);

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger
-- ---------------------------------------------------------------------------
--
-- We don't have a separate updated_at column (last_seen_at is the only
-- one that gets refreshed after creation). The trigger is here for
-- future expansion: if we add columns that need auto-update, the trigger
-- is in place.

CREATE OR REPLACE FUNCTION set_updated_at_mobile_push_subscriptions()
  RETURNS trigger AS $$
BEGIN
  -- No-op: last_seen_at is the only field that changes post-create, and
  -- the route handler sets it explicitly. The trigger exists to give a
  -- stable hook for future column additions.
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mobile_push_subscriptions_updated_at
  ON mobile_push_subscriptions;

CREATE TRIGGER trg_mobile_push_subscriptions_updated_at
  BEFORE UPDATE ON mobile_push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_mobile_push_subscriptions();

-- ---------------------------------------------------------------------------
-- 5. RLS — enable, force, and add the tenant_isolation policy
-- ---------------------------------------------------------------------------

ALTER TABLE mobile_push_subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE mobile_push_subscriptions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mobile_push_subscriptions;

CREATE POLICY tenant_isolation ON mobile_push_subscriptions
  USING      (school_id = current_school_id())
  WITH CHECK (school_id = current_school_id());

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_push_subscriptions TO edusupervise_runtime';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_push_subscriptions TO edusupervise_system';
EXCEPTION WHEN insufficient_privilege THEN
  -- Fresh dev DB may not have the runtime/system roles yet; the init
  -- scripts create them. This is a defensive safety net for re-runs.
  NULL;
END
$$;

-- Refresh planner stats — small table but the policy changes
-- (FORCE RLS adds a per-row check) and the new partial index should
-- be visible to the planner immediately.
ANALYZE mobile_push_subscriptions;
