-- Migration 0009: Group duties — many-to-many dutyAssignments + coverageRole
-- (docs/superpowers/specs/2026-07-04-phase-3-school.md §3.1)
--
-- Background: Jason's PDF has merged assignment rows like
-- "Cyriac, Loganathan, Sheikh" covering one duty slot. The existing
-- duty_assignments table already supports N rows per duty (the unique
-- constraint would have to be (school_id, duty_id, user_id) and there
-- isn't one), but it has no concept of WHO is first / backup / rotation
-- nor who assigned them (admin vs self-onboarding).
--
-- Why ADD CONSTRAINT instead of pgEnum:
-- The same reasoning as migration 0007: the live DB stores these
-- fields as TEXT with a CHECK constraint, not a Postgres enum.
-- Drizzle's pgEnum is a TypeScript abstraction only. This keeps the
-- DB-side CHECK pattern consistent with the rest of the project and
-- avoids an ALTER TYPE chain (0007 pattern).
--
-- Three additive changes:
--   1. Add `assigned_by_user_id uuid REFERENCES users(id)` — nullable
--      so existing rows keep working. Used for audit (admin assigned
--      vs teacher self-onboarded).
--   2. Add `coverage_role text NOT NULL DEFAULT 'primary'` with a
--      CHECK to keep the column restricted to the three valid values.
--      Default 'primary' preserves backward compatibility — every
--      pre-existing assignment is treated as the primary on that duty.
--   3. Add a UNIQUE index on (school_id, duty_id, user_id, coverage_role)
--      so the same user can't be tagged "primary" twice on the same
--      duty (which would be a data-entry bug, not a meaningful model).
--      Distinct users can still all be "primary" / "backup" / "rotation"
--      on the same duty — that's the whole point of Phase 3 §3.1.
--
-- Idempotent: every ADD COLUMN uses IF NOT EXISTS, every DROP
-- CONSTRAINT uses IF EXISTS, and the UNIQUE index uses
-- CREATE UNIQUE INDEX IF NOT EXISTS.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. assigned_by_user_id — nullable audit column
-- ---------------------------------------------------------------------------

ALTER TABLE duty_assignments
  ADD COLUMN IF NOT EXISTS assigned_by_user_id uuid REFERENCES users(id);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_assignments_assigned_by
  ON duty_assignments (school_id, assigned_by_user_id)
  WHERE assigned_by_user_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. coverage_role — text + CHECK (one of three valid values)
-- ---------------------------------------------------------------------------

ALTER TABLE duty_assignments
  ADD COLUMN IF NOT EXISTS coverage_role text NOT NULL DEFAULT 'primary';--> statement-breakpoint

-- Replace the existing CHECK constraint (which only covers end_date) with
-- an updated one that ALSO restricts coverage_role. We keep the end_date
-- check unchanged so we don't regress existing data validation.
ALTER TABLE duty_assignments DROP CONSTRAINT IF EXISTS duty_assignments_check;--> statement-breakpoint

ALTER TABLE duty_assignments
  ADD CONSTRAINT duty_assignments_check
  CHECK (
    (end_date IS NULL OR end_date >= start_date)
    AND coverage_role = ANY (ARRAY['primary'::text, 'backup'::text, 'rotation'::text])
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. UNIQUE (school_id, duty_id, user_id, coverage_role)
--    Prevents the same user from being tagged "primary" twice on the
--    same duty. Does NOT prevent three different users from all being
--    "primary" / different roles on the same duty (the intended use).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS duty_assignments_duty_user_role_unique
  ON duty_assignments (school_id, duty_id, user_id, coverage_role);--> statement-breakpoint
