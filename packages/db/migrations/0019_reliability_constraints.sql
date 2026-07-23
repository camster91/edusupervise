-- Migration 0016: reliability constraints and index-drift repair
--
-- Applied migrations 0000-0015 are immutable. This follow-up makes the
-- database match packages/db/src/schema.ts and closes race windows in the
-- coverage/parent-alert paths.

-- coverage_events external ids are provider-scoped AND tenant-scoped. The
-- original 0002 index omitted school_id, so equal provider ids in two schools
-- conflicted even though they are unrelated events.
-- Migration 0002 also predated broadcast mode; bring its CHECK constraints in
-- line with the values the application now writes.
ALTER TABLE coverage_events
  DROP CONSTRAINT IF EXISTS coverage_events_source_check;
ALTER TABLE coverage_events
  ADD CONSTRAINT coverage_events_source_check
  CHECK (source IN ('direct', 'frontline', 'red_rover', 'swing', 'manual', 'broadcast'));
ALTER TABLE coverage_assignments
  DROP CONSTRAINT IF EXISTS coverage_assignments_status_check;
ALTER TABLE coverage_assignments
  ADD CONSTRAINT coverage_assignments_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'uncovered', 'cancelled'));

DROP INDEX IF EXISTS coverage_events_external_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS coverage_events_school_source_external_id_unique
  ON coverage_events (school_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Remove exact duplicate assignment candidates left by historical concurrent
-- retries before adding uniqueness. Rows referenced by parent alerts are
-- never deleted automatically; if such duplicates exist, stop the migration
-- so an operator can merge them without discarding alert history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM coverage_assignments AS assignment
    JOIN parent_alerts AS alert
      ON alert.coverage_assignment_id = assignment.id
    WHERE EXISTS (
      SELECT 1
      FROM coverage_assignments AS duplicate
      WHERE duplicate.coverage_event_id = assignment.coverage_event_id
        AND duplicate.duty_id = assignment.duty_id
        AND duplicate.new_teacher_id IS NOT DISTINCT FROM assignment.new_teacher_id
        AND duplicate.id <> assignment.id
    )
  ) THEN
    RAISE EXCEPTION
      'duplicate coverage assignments referenced by parent alerts require manual merge';
  END IF;
END $$;

WITH ranked_assignments AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY coverage_event_id, duty_id, new_teacher_id
      ORDER BY
        CASE status
          WHEN 'accepted' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'declined' THEN 2
          WHEN 'uncovered' THEN 3
          ELSE 4
        END,
        responded_at DESC NULLS LAST,
        created_at,
        id
    ) AS duplicate_rank
  FROM coverage_assignments
)
DELETE FROM coverage_assignments AS assignment
USING ranked_assignments AS ranked
WHERE assignment.id = ranked.id
  AND ranked.duplicate_rank > 1;

-- Broadcast mode permits several distinct teachers for one event/duty. It
-- does not permit the same teacher twice. NULL candidates represent the sole
-- "uncovered" row and need their own partial unique index because ordinary
-- unique indexes treat NULL values as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS coverage_assignments_event_duty_teacher_unique
  ON coverage_assignments (coverage_event_id, duty_id, new_teacher_id)
  WHERE new_teacher_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS coverage_assignments_event_duty_uncovered_unique
  ON coverage_assignments (coverage_event_id, duty_id)
  WHERE new_teacher_id IS NULL;

-- These already exist in applied SQL but were absent/inaccurate in the
-- Drizzle schema. Reassert them idempotently and repair the active-device
-- lookup so revoked rows are excluded as its name promises.
CREATE UNIQUE INDEX IF NOT EXISTS parent_alerts_parent_assignment_unique
  ON parent_alerts (parent_id, coverage_assignment_id);
CREATE INDEX IF NOT EXISTS idx_mobile_push_subscriptions_token
  ON mobile_push_subscriptions (expo_push_token);
DROP INDEX IF EXISTS idx_mobile_push_subscriptions_school_user_active;
CREATE INDEX idx_mobile_push_subscriptions_school_user_active
  ON mobile_push_subscriptions (school_id, user_id)
  WHERE revoked_at IS NULL;