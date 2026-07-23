-- 02-schema.sql — runs as edusupervise_owner (POSTGRES_USER) on first
-- container boot, AFTER 01-roles.sql. Creates every table from spec section 4
-- verbatim, plus the per-table ENABLE + FORCE + POLICY loop (DO block) and
-- table-level GRANTs for runtime + system roles.
--
-- Drizzle-kit migrations are the source of truth going forward; this file is
-- the bootstrap so a fresh deploy has the full schema (and RLS policies)
-- before any app code runs.
--
-- Tenant-owned tables get:
--   ALTER TABLE ... ENABLE ROW LEVEL SECURITY
--   ALTER TABLE ... FORCE  ROW LEVEL SECURITY
--   CREATE POLICY tenant_isolation ON <table>
--     USING      (school_id = current_school_id())
--     WITH CHECK (school_id = current_school_id())
--
-- FORCE is required because the runtime role does NOT own tables. Without
-- FORCE, a non-owner role with no explicit policy would silently bypass RLS.

\set ON_ERROR_STOP on

-- gen_random_uuid() lives in pgcrypto on stock postgres:16-alpine.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================
-- Tenancy
-- =========================================

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  cycle_days INTEGER NOT NULL DEFAULT 5 CHECK (cycle_days BETWEEN 1 AND 10),
  school_year_start DATE NOT NULL,
  school_year_end DATE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'free', 'pro', 'school')),
  trial_ends_at TIMESTAMPTZ,
  plan_downgrade_pending_to TEXT,
  plan_downgrade_effective_at TIMESTAMPTZ,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  logo_url TEXT,
  accent_color TEXT DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (school_year_end > school_year_start),
  CHECK (school_year_end <= school_year_start + interval '14 months')
);

CREATE INDEX IF NOT EXISTS idx_schools_slug ON schools(slug);

-- =========================================
-- Users + auth
-- =========================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('school_admin', 'teacher', 'substitute')),
  phone TEXT,
  phone_verified_at TIMESTAMPTZ,
  avatar_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(school_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_school_id ON users(school_id);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);

-- Sessions, accounts, verification are owned by better-auth (auto-created by
-- better-auth's Drizzle adapter on first auth event). They're tenant-owned
-- tables and are included in the RLS loop below.

-- =========================================
-- Cycle calendar
-- =========================================

CREATE TABLE IF NOT EXISTS cycle_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  cycle_day INTEGER,
  is_school_day BOOLEAN NOT NULL DEFAULT true,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(school_id, date)
);

CREATE INDEX IF NOT EXISTS idx_cycle_calendar_school_date ON cycle_calendar(school_id, date);

-- =========================================
-- Duties
-- =========================================

CREATE TABLE IF NOT EXISTS duties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  cycle_day INTEGER NOT NULL CHECK (cycle_day >= 1),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  requires_vest BOOLEAN NOT NULL DEFAULT false,
  requires_radio BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_duties_school_cycle ON duties(school_id, cycle_day) WHERE is_active;

-- =========================================
-- Duty assignments
-- =========================================

CREATE TABLE IF NOT EXISTS duty_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  duty_id UUID NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_assignments_school_user ON duty_assignments(school_id, user_id);
CREATE INDEX IF NOT EXISTS idx_assignments_school_duty ON duty_assignments(school_id, duty_id);

-- =========================================
-- Reminders
-- =========================================

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL CHECK (minutes_before >= 0 AND minutes_before <= 10080),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_sms BOOLEAN NOT NULL DEFAULT false,
  custom_message TEXT CHECK (custom_message IS NULL OR length(custom_message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminders_school_assignment ON reminders(school_id, assignment_id);

-- =========================================
-- Reminder dispatch log
-- =========================================
--
-- NOTE: reminder_log.channel is the `reminder_channel` Postgres ENUM
-- (declared at the top of this file as ('email','sms')). Migration
-- 0015 added 'push-expo' to that enum. For a fresh-DB bootstrap that
-- runs init/* before migrations/*, the enum is created without the
-- 'push-expo' value, and any INSERT with channel='push-expo' fails
-- until 0015 runs. The 'push-expo' value must be added inline here so
-- the bootstrap order doesn't leave the column in a state that rejects
-- mobile-app reminder writes.
--
-- Audit 2026-07-22 P1-4.

CREATE TYPE IF NOT EXISTS reminder_channel AS ENUM ('email', 'sms', 'push-expo');

CREATE TABLE IF NOT EXISTS reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  channel reminder_channel NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reminder_id, scheduled_for, channel)
);

CREATE INDEX IF NOT EXISTS idx_reminder_log_school_status ON reminder_log(school_id, status);
CREATE INDEX IF NOT EXISTS idx_reminder_log_assignment    ON reminder_log(assignment_id);

-- =========================================
-- Outbox (transactional queue)
-- =========================================

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(created_at) WHERE enqueued_at IS NULL;

-- =========================================
-- Audit log
-- =========================================

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_school_created ON audit_log(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target         ON audit_log(school_id, target_type, target_id);

-- =========================================
-- Stripe webhook idempotency
-- =========================================

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================
-- Worker heartbeats (system-only)
-- =========================================

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  last_beat TIMESTAMPTZ NOT NULL,
  jobs_completed BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL
);

-- =========================================
-- Notifications (in-app)
-- =========================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reminder.failed', 'plan.downgrade.pending', 'plan.downgrade.applied', 'system.message')),
  title TEXT NOT NULL,
  body TEXT,
  link_url TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- =========================================
-- Push notification subscriptions (Tier 2)
-- =========================================
-- One row per (school, user, browser endpoint). See
-- db/migrations/2026-06-28-push-subscriptions.sql for the matching
-- migration file (kept in sync with this bootstrap block).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(school_id, user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(school_id, user_id);

-- =========================================
-- Plan limits (global lookup, no RLS)
-- =========================================

CREATE TABLE IF NOT EXISTS plan_limits (
  plan TEXT PRIMARY KEY,
  max_teachers INTEGER NOT NULL,
  max_duties INTEGER NOT NULL,
  max_reminders_per_assignment INTEGER NOT NULL,
  sms_included BOOLEAN NOT NULL DEFAULT false,
  audit_retention_days INTEGER NOT NULL
);

-- =========================================
-- RLS — enable AND force on every tenant-owned table
-- =========================================
--
-- Helper that reads the per-transaction `app.school_id` GUC. Used by every
-- tenant policy. Returns NULL when not set; policies short-circuit on NULL
-- so unauthenticated calls cannot read any row.

CREATE OR REPLACE FUNCTION current_school_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- DO block: ENABLE + FORCE + POLICY for each tenant-owned table.
-- FORCE is the multi-tenancy boundary: runtime role doesn't own tables,
-- so without FORCE it would silently bypass RLS.
--
-- NOTE (audit S-S3, 2026-07-04): `auth_session` is intentionally NOT
-- in this loop. It has no direct `school_id` column — the user it
-- belongs to lives in `public.users` and we join through that for RLS.
-- The shape of that policy is different (subquery, not direct column
-- comparison), so it lives in migration 0011_auth_session_rls.sql.
-- That migration runs after this init script on a fresh DB, and on
-- existing deployments via `pnpm --filter @edusupervise/db migrate`.
-- If you add a new tenant-owned table below, ALSO add an entry to
-- migration 0012+ so RLS follows the data.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'cycle_calendar', 'duties', 'duty_assignments',
    'reminders', 'reminder_log', 'audit_log', 'notifications',
    'push_subscriptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING      (school_id = current_school_id()) '
      'WITH CHECK (school_id = current_school_id())',
      t
    );
  END LOOP;
END
$$;

-- Schools table: a user can see only their own school (self-isolation,
-- not tenant-list-isolation; tenant list is intentionally a global no-go
-- since one DB == one school).

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE  ROW LEVEL SECURITY;
CREATE POLICY school_self ON schools
  USING      (id = current_school_id())
  WITH CHECK (id = current_school_id());

-- =========================================
-- Grants on every table for runtime + system roles (after tables exist).
-- Idempotent via dynamic SQL: re-runs apply to new tables without erroring.
-- =========================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO edusupervise_runtime', r.tablename);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO edusupervise_system',  r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO edusupervise_runtime', r.sequence_name);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO edusupervise_system',  r.sequence_name);
  END LOOP;
END
$$;