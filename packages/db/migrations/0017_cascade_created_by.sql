-- Migration 0017: ON DELETE CASCADE for created_by FKs
--
-- Why: account-deletion hard-delete (migration 0016) tries to DELETE
-- FROM users but the duties/coverage_events/duty_assignments.created_by
-- columns are NOT NULL with NO ACTION FKs, so the delete fails with
-- "violates foreign key constraint". We have three options:
--
--   1. SET NULL the created_by on those tables before deleting
--      → blocked: created_by is NOT NULL on 3 of 4 tables.
--   2. Hard-delete the dependent duties/coverage_events/duty_assignments
--      in the cron → works but couples account-deletion to per-table
--      knowledge; breaks the next time someone adds a new table with
--      created_by → users.
--   3. ON DELETE CASCADE on the FK → the database enforces cleanup
--      atomically and the cron just deletes the user.
--
-- Picking (3). The semantic is: when a user is hard-deleted, their
-- created content goes with them. The 30-day grace period (set in
-- 0016) gives the user time to cancel. If they don't, they (and their
-- content) are gone. Soft-delete is still preserved: the
-- pending_deletion_at flag and is_active=false make the user's content
-- effectively hidden for the 30 days, and only the hard-delete cron
-- (which runs after 30 days) actually triggers this CASCADE.
--
-- recurring_duties.created_by is nullable and uses NO ACTION; we leave
-- it alone — the SET NULL path there already works, and recurring
-- duties are templates the school may still want to use.

BEGIN;

-- Drop the old FKs
ALTER TABLE duties
  DROP CONSTRAINT duties_created_by_fkey;
ALTER TABLE coverage_events
  DROP CONSTRAINT coverage_events_created_by_users_id_fk;
ALTER TABLE duty_assignments
  DROP CONSTRAINT duty_assignments_created_by_fkey;
ALTER TABLE duty_assignments
  DROP CONSTRAINT duty_assignments_assigned_by_user_id_fkey;
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_user_id_fkey;

-- Re-add with ON DELETE CASCADE
ALTER TABLE duties
  ADD CONSTRAINT duties_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE coverage_events
  ADD CONSTRAINT coverage_events_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE duty_assignments
  ADD CONSTRAINT duty_assignments_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE duty_assignments
  ADD CONSTRAINT duty_assignments_assigned_by_user_id_fkey
  FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- recurring_duties.created_by: nullable + NO ACTION. SET NULL on
-- delete is what we want here (the recurring template outlives the
-- user; they just stop being attributed). Change NO ACTION to
-- SET NULL so the FK doesn't block the delete.
ALTER TABLE recurring_duties
  DROP CONSTRAINT recurring_duties_created_by_fkey;
ALTER TABLE recurring_duties
  ADD CONSTRAINT recurring_duties_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
