-- Migration 0005: extend notifications.kind CHECK to allow duty_assigned
--
-- The smoke test on 2026-06-29 surfaced: coverage.server.ts inserts
-- into `notifications` with `kind='duty_assigned'`, but the existing
-- CHECK constraint on `notifications.kind` doesn't list that value.
-- The INSERT fires the CHECK, the transaction rolls back, and the
-- replacement-teacher notification silently aborts.
--
-- psql output from the live DB before this migration:
--   "notifications_kind_check" CHECK (kind = ANY (ARRAY[
--     'reminder.failed'::text,
--     'plan.downgrade.pending'::text,
--     'plan.downgrade.applied'::text,
--     'system.message'::text
--   ]))
--
-- This migration drops the old CHECK and recreates it with the two
-- additional values. Idempotent (DROP IF EXISTS guards the replace).
--
-- Note: pgEnum in packages/db/src/schema.ts is also updated to match
-- (`duty_assigned`, `duty.coverage_changed`). The runtime pgEnum is
-- the Drizzle-side abstraction; this migration is the Postgres-side
-- authority.

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_kind_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK (kind = ANY (ARRAY[
    'reminder.failed'::text,
    'plan.downgrade.pending'::text,
    'plan.downgrade.applied'::text,
    'system.message'::text,
    'duty_assigned'::text,
    'duty.coverage_changed'::text
  ]));

ANALYZE notifications;
