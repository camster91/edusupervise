-- Migration 0013: cycle_calendar — add is_instructional + holiday_code
--
-- Context: a teacher uploads their school calendar PDF; the importer
-- populates cycle_calendar with one row per date. The existing
-- is_school_day boolean captures "in session vs out of session" at a
-- coarse level; the PDF importer needs two more granular fields:
--
--   is_instructional  boolean — "are classes running and duties active
--                                on this date?" PDF calendars often
--                                distinguish a "school in session" day
--                                (e.g. PD day with students off but
--                                staff on-site, half-day, exam day)
--                                from a "regular instructional" day.
--                                Default true so legacy rows behave
--                                identically to is_school_day = true.
--
--   holiday_code      text    — short slug the importer emits when a
--                                date is non-instructional. Lets the UI
--                                display "Winter Recess" / "PD Day"
--                                without a second lookup table.
--                                Nullable: most rows will be NULL
--                                (regular instructional days).
--
-- Forward-compat:
--   - Both columns live on cycle_calendar → existing tenant_isolation
--     RLS policy covers them automatically. No new policy needed.
--   - The (school_id, date) UNIQUE constraint is unchanged.
--   - No existing index is dropped.
--
-- Online-safe: ADD COLUMN ... DEFAULT true is a Postgres 11+
-- metadata-only operation when no row rewrite is required. Both
-- new columns are nullable / have safe defaults so the migration can
-- run while the app is live. The backfill UPDATE is short-circuit
-- via WHERE ... IS DISTINCT FROM, so re-runs are no-ops.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- ADD CONSTRAINT inside DO $$ ... IF NOT EXISTS blocks.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------

ALTER TABLE cycle_calendar
  ADD COLUMN IF NOT EXISTS is_instructional boolean NOT NULL DEFAULT true;

ALTER TABLE cycle_calendar
  ADD COLUMN IF NOT EXISTS holiday_code text;

-- ---------------------------------------------------------------------------
-- 2. Backfill is_instructional from is_school_day for existing rows.
--
-- The default `true` already matches is_school_day's default for any
-- row that was inserted with neither column touched, which is the
-- overwhelming majority. The UPDATE below only flips the edge case
-- where is_school_day was explicitly set to false (weekends, recesses,
-- PD days that pre-date this migration). The clause
--   is_instructional IS DISTINCT FROM is_school_day
-- makes the UPDATE a no-op on re-runs.
--
-- Note: the two columns are NOT semantically equivalent going forward.
-- is_school_day stays a coarse "in/out of session" flag for backwards
-- compat with existing code paths (duty scheduler, attendance). The
-- new is_instructional is the finer-grained flag the PDF importer
-- writes. After this backfill they agree; future writes may diverge.
-- ---------------------------------------------------------------------------

UPDATE cycle_calendar
   SET is_instructional = is_school_day
 WHERE is_instructional IS DISTINCT FROM is_school_day;

-- ---------------------------------------------------------------------------
-- 3. CHECK constraints
-- ---------------------------------------------------------------------------

-- holiday_code must be NULL or one of the importer's recognised codes.
-- Codes mirror what a typical school-district calendar PDF emits:
--   holiday     — statutory holiday (Labour Day, Christmas, etc.)
--   recess      — multi-day break between terms (Winter Recess, March Break)
--   pd_day      — professional development day, staff only
--   exam        — exam day, modified schedule
--   half_day    — half-day schedule
--   weather     — weather closure (snow day)
--   in_service  — staff in-service / training
--   break       — single-day mid-term break (not multi-day recess)
-- The set can be extended via a follow-up migration when the importer
-- gains new codes. Length cap defends against importer bugs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cycle_calendar_holiday_code_values'
  ) THEN
    ALTER TABLE cycle_calendar
      ADD CONSTRAINT cycle_calendar_holiday_code_values
      CHECK (
        holiday_code IS NULL OR holiday_code = ANY (ARRAY[
          'holiday'::text,
          'recess'::text,
          'pd_day'::text,
          'exam'::text,
          'half_day'::text,
          'weather'::text,
          'in_service'::text,
          'break'::text
        ])
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cycle_calendar_holiday_code_length'
  ) THEN
    ALTER TABLE cycle_calendar
      ADD CONSTRAINT cycle_calendar_holiday_code_length
      CHECK (holiday_code IS NULL OR length(holiday_code) <= 32);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Partial index for "non-instructional days in a date range"
--
-- Query pattern that benefits:
--   SELECT date FROM cycle_calendar
--    WHERE school_id = $1
--      AND date BETWEEN $2 AND $3
--      AND is_instructional = false
-- (used by the duty scheduler to skip holidays when generating upcoming
-- duty occurrences).
--
-- Partial index is much smaller than the existing
-- (school_id, date) btree — it indexes only the rows that match the
-- filter, so it stays cheap even when most dates are instructional.
-- Postgres can use this index for the IS FALSE predicate directly;
-- the planner picks it over the full btree because the heap-side
-- filter is folded into the index condition.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_cycle_calendar_non_instructional
  ON cycle_calendar (school_id, date)
  WHERE is_instructional = false;

-- ---------------------------------------------------------------------------
-- 5. Grants on new column for runtime role
--
-- The init-time grant loop in 02-schema.sql grants table-level
-- SELECT/INSERT/UPDATE/DELETE on every public table to the runtime
-- role; column-level grants are unnecessary. The new columns inherit
-- those table-level grants automatically. (No GRANT statements needed
-- for columns.)
-- ---------------------------------------------------------------------------

ANALYZE cycle_calendar;