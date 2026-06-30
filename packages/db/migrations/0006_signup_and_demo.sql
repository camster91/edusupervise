-- Migration 0006: Public signup + demo mode (spec docs/superpowers/specs/2026-06-29--public-signup-and-demo-mode.md)
--
-- This migration is run MANUALLY in 3 psql invocations because Postgres
-- does not allow more than one ALTER TYPE ... ADD VALUE inside a single
-- transaction. Order matters: enum values must exist before the
-- DEFAULT / CHECK constraints that reference them.
--
--   psql ... -c "ALTER TYPE school_plan ADD VALUE IF NOT EXISTS 'demo';"
--   psql ... -c "ALTER TYPE school_plan ADD VALUE IF NOT EXISTS 'demo_expired';"
--   psql ... -f 0006_signup_and_demo.sql
--
-- Idempotent: every ADD COLUMN / CREATE INDEX / CREATE TABLE uses
-- IF NOT EXISTS where the syntax supports it; GRANT statements are
-- additive (Postgres grants are idempotent by default).

-- ============================================================================
-- Step 3 content (run AFTER both ALTER TYPE statements above have committed)
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- schools: add join_code, demo_expires_at, demo_seed_variant
-- ---------------------------------------------------------------------------

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS join_code text;

-- Backfill existing rows with a unique code derived from id. The fallback
-- is the first 4 chars of the uuid uppercased + a 2-digit hash of the
-- full uuid (00–99). On UNIQUE collision we retry up to 10 times; if all
-- fail the row gets a sentinel 'LEGACY-NN' code which an admin can
-- rename from /app/settings.
DO $$
DECLARE
  r record;
  attempt int;
  candidate text;
BEGIN
  FOR r IN SELECT id FROM schools WHERE join_code IS NULL LOOP
    attempt := 0;
    LOOP
      candidate := upper(substring(replace(r.id::text, '-', '') from 1 for 4)) || '-' ||
                   lpad(((abs(hashtext(r.id::text)) % 100))::text, 2, '0');
      BEGIN
        UPDATE schools SET join_code = candidate WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        attempt := attempt + 1;
        IF attempt > 10 THEN
          UPDATE schools SET join_code = 'LEGACY-' || lpad(((abs(hashtext(r.id::text)) % 100))::text, 2, '0')
            WHERE id = r.id;
          EXIT;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE schools
  ALTER COLUMN join_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_join_code ON schools (join_code);

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS demo_expires_at timestamptz;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS demo_seed_variant text;

-- ---------------------------------------------------------------------------
-- signup_attempts: rate-limit + audit trail for /api/signup/* endpoints.
--
-- Global table (no school_id) so a fresh signup attempt is logged before
-- we know which school the user is joining. Indexed on (email, created_at)
-- and (ip_address, created_at) so the rate-limit query is a cheap
-- range scan.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signup_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  ip_address  inet,
  user_agent  text,
  mode        text NOT NULL,
  outcome     text NOT NULL,
  school_id   uuid REFERENCES schools(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_email_created
  ON signup_attempts (email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_created
  ON signup_attempts (ip_address, created_at DESC)
  WHERE ip_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signup_attempts_outcome
  ON signup_attempts (outcome, created_at DESC);

-- CHECK constraints
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'signup_attempts_mode_check'
  ) THEN
    ALTER TABLE signup_attempts
      ADD CONSTRAINT signup_attempts_mode_check
      CHECK (mode = ANY (ARRAY['join', 'solo', 'demo']));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'signup_attempts_outcome_check'
  ) THEN
    ALTER TABLE signup_attempts
      ADD CONSTRAINT signup_attempts_outcome_check
      CHECK (outcome = ANY (ARRAY[
        'success', 'invalid_code', 'duplicate_email',
        'quota_full', 'rate_limited', 'error'
      ]));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants for runtime + system roles
--
-- The runtime role can INSERT into signup_attempts (for the rate-limit /
-- audit log) but cannot UPDATE/DELETE — those would let a runtime
-- process cover its tracks. The system role gets full CRUD so cron / a
-- future analytics job can purge old attempts.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON signup_attempts TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON signup_attempts TO edusupervise_system;

-- New schools columns: read+write by both roles. The runtime role can
-- UPDATE join_code (admin wants to rename) and demo_expires_at (the
-- reset-demo action extends it). The system role owns the writes for
-- cron / migrations.
GRANT UPDATE (join_code, demo_expires_at, demo_seed_variant, updated_at)
  ON schools TO edusupervise_runtime;

ANALYZE schools;
ANALYZE signup_attempts;