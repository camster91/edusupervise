-- Migration 0014: fix cycle_calendar.holiday_code CHECK to match the
-- parser's actual output.
--
-- Context (2026-07-05): migration 0013 (committed 07ee533) added the
-- holiday_code column with a CHECK constraint that whitelists eight
-- human-readable slugs (holiday, recess, pd_day, exam, half_day,
-- weather, in_service, break). But the PDF calendar parser
-- (apps/web/server/pdf_calendar_extract.py) emits one-letter codes
-- from the YRDSB template — B (board holiday), E (elementary PA),
-- ES (elem/sec PA), M (mandatory holiday), 0 (day-zero PA).
--
-- The TS wrapper (apps/web/server/pdf_calendar_extract.server.ts)
-- re-validates and whitelists only those one-letter codes.
--
-- Result: every non-instructional day collides with the CHECK and
-- the admin's commit throws, leaving a partial cycle_calendar row
-- set with no audit log entry. Caught by app-ship-prep verifier
-- (session mvs_498818874f5b439ebb78debd3277d2e1) before production
-- exposure.
--
-- This migration replaces the bad CHECK with one that matches the
-- parser's output. Online-safe + idempotent.
--
-- Forward-compat: if a future district needs additional codes
-- (e.g. 'H' for statutory holiday distinct from 'M'), extend the
-- ARRAY in this migration. Keep the set tight — every value here
-- gates downstream UI display strings.
--
-- Idempotent: uses IF EXISTS / DO $$ guards so re-running is a no-op.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Drop the bad CHECK (it locks the table briefly with ACCESS EXCLUSIVE;
--    this migration should run during a low-write window or while the web
--    container is paused for a deploy).
-- ---------------------------------------------------------------------------

ALTER TABLE cycle_calendar
  DROP CONSTRAINT IF EXISTS cycle_calendar_holiday_code_values;

-- ---------------------------------------------------------------------------
-- 2. Re-add the CHECK with the parser's actual one-letter codes.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cycle_calendar_holiday_code_values'
  ) THEN
    ALTER TABLE cycle_calendar
      ADD CONSTRAINT cycle_calendar_holiday_code_values
      CHECK (
        holiday_code IS NULL OR holiday_code = ANY (
          ARRAY['B','E','ES','M','0']
        )
      );
  END IF;
END $$;
