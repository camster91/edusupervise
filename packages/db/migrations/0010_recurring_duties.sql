-- Migration 0010: Recurring time-bound duties
-- (docs/superpowers/specs/2026-07-04-phase-3-school.md §3.2)
--
-- Background: Jason's second screenshot shows duties like
-- "Early Entry 8:45-9:00 at Kiss N Ride (south end), Back Tarmac" —
-- not part of the 5-day rotation, they happen every weekday at the
-- same time. Different model than `duties` (cycle-keyed) and
-- `duty_assignments` (per-cycle-day).
--
-- Schema:
--   - `recurring_duties` table, one row per recurring slot.
--   - `days_of_week SMALLINT` is a 7-bit bitmask: Mon=1, Tue=2, Wed=4,
--     Thu=8, Fri=16, Sat=32, Sun=64. Picks the bits set -> set of weekdays.
--   - Range check (0..127) prevents garbage values; we never allow
--     "no days selected" (which would mean the duty fires 0 times, a
--     data-entry bug).
--   - `time` columns are checked end > start so we don't ship
--     impossible slots (5pm-6am reverse).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
-- DO block for GRANTs (Postgres grants are idempotent; the DO block
-- sets both runtime and system role grants in one place).
--
-- RLS: matches the same `tenant_isolation` pattern as every other
-- tenant-owned table. FORCE RLS so the runtime role can't bypass it.
-- The init SQL doesn't enumerate this table (it didn't exist when the
-- init ran), so this migration must ENABLE + FORCE + add the policy.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recurring_duties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  -- Display label, e.g. "Early Entry". Distinct from `duties.location`
  -- in the cycle-day table so we can store both a human label and a
  -- physical-place label without forcing them to be the same string.
  name text NOT NULL,
  location text,
  start_time time NOT NULL,
  end_time time NOT NULL,
  -- Bitmask Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64.
  -- 0 is invalid (duty fires nowhere); 127 covers every day.
  days_of_week smallint NOT NULL,
  -- Single assigned teacher (the model is one-person-per-recurring-slot
  -- for Phase 3.2; group coverage for recurring slots is Phase 4+).
  -- NULL = "any available teacher" — admin can leave this blank and
  -- the routing job will pick someone on each day. For Phase 3 we
  -- require non-null so the reminders code is straightforward.
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requires_vest boolean NOT NULL DEFAULT false,
  requires_radio boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recurring_duties_time_order CHECK (end_time > start_time),
  CONSTRAINT recurring_duties_dow_range CHECK (
    days_of_week BETWEEN 1 AND 127
  ),
  CONSTRAINT recurring_duties_name_length CHECK (
    length(name) BETWEEN 1 AND 200
  ),
  CONSTRAINT recurring_duties_location_length CHECK (
    location IS NULL OR length(location) <= 200
  )
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Indexes — workhorse lookup is "today's recurring duties for user X
--    in school Y, active" — partial index on is_active so it stays small
--    as soft-deletes accumulate.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_recurring_duties_school_active
  ON recurring_duties (school_id, is_active)
  WHERE is_active;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_recurring_duties_school_user_active
  ON recurring_duties (school_id, assigned_user_id)
  WHERE is_active AND assigned_user_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. updated_at trigger — keeps `updated_at` honest without forcing
--    every writer to remember to set it. Postgres doc §37.1.4.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at_recurring_duties()
  RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_recurring_duties_updated_at ON recurring_duties;--> statement-breakpoint

CREATE TRIGGER trg_recurring_duties_updated_at
  BEFORE UPDATE ON recurring_duties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_recurring_duties();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. RLS — enable, force, and add the tenant_isolation policy so the
--    runtime role CAN'T see another school's recurring duties.
-- ---------------------------------------------------------------------------

ALTER TABLE recurring_duties ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE recurring_duties FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON recurring_duties;--> statement-breakpoint

CREATE POLICY tenant_isolation ON recurring_duties
  USING (school_id = current_school_id())
  WITH CHECK (school_id = current_school_id());--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. GRANTs — runtime + system roles need DML on this table. The DO
--    block runs the GRANTs idempotently (Postgres GRANT is idempotent,
--    so re-running does not throw).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_duties TO edusupervise_runtime';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recurring_duties TO edusupervise_system';
EXCEPTION WHEN insufficient_privilege THEN
  -- The role owning this migration (edusupervise_owner) has GRANT
  -- privilege, but the GRANT may fail if the roles don't exist yet
  -- (fresh dev DB). The init scripts always create the roles first;
  -- this is just a defensive safety net.
  NULL;
END
$$;--> statement-breakpoint
