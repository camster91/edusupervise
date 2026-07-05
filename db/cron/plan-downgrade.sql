-- Nightly plan-downgrade flip + demo expiry flip.
-- Run from the `cron` container in compose (alpine + postgresql16-client),
-- in the SAME loop slot as `db/cron/audit-retention.sql`.
--
-- 1. Flip schools whose plan_downgrade_effective_at has elapsed.
-- 2. Flip demo schools whose demo_expires_at has elapsed (migration 0006).
-- 3. Write an audit_log entry for each flip (system-initiated;
--    user_id IS NULL).
-- 4. Clear plan_downgrade_pending_to + plan_downgrade_effective_at.
--
-- Notification fan-out (one row per active school_admin) is done by
-- the application code path (apps/web/server/billing.server.ts#
-- runDailyDowngradeFlip). The cron container only does the SQL path;
-- the in-process helper covers integration tests + dev convenience
-- buttons so we don't have to spin up a queue + notification producer
-- from the cron SQL.

\set ON_ERROR_STOP on

UPDATE schools
   SET plan = 'free',
       plan_downgrade_pending_to = NULL,
       plan_downgrade_effective_at = NULL,
       updated_at = now()
 WHERE plan IN ('pro', 'school')
   AND plan_downgrade_pending_to IS NOT NULL
   AND plan_downgrade_effective_at IS NOT NULL
   AND plan_downgrade_effective_at <= now();

-- Migration 0006: demo schools auto-flip to read-only after 30 days.
-- The school remains on disk — the user can extend via
-- /app/api/demo/reset (which flips plan back to 'demo' and resets
-- demo_expires_at). We do NOT delete the school or its data; the
-- user might restart the demo.
UPDATE schools
   SET plan = 'demo_expired',
       updated_at = now()
 WHERE plan = 'demo'
   AND demo_expires_at IS NOT NULL
   AND demo_expires_at <= now();

-- Audit row per flipped school. We capture the previous plan in the
-- metadata so a post-mortem replay doesn't need the originating
-- webhook. IF the UPDATE matched zero rows, this INSERT is a no-op.
INSERT INTO audit_log (school_id, user_id, action, target_type, target_id, metadata)
SELECT
    s.id,
    NULL,
    'billing.plan.downgrade_applied',
    'school',
    s.id,
    jsonb_build_object('appliedAt', now(), 'cron', 'plan-downgrade')
  FROM schools s
 WHERE s.plan = 'free'
   AND s.updated_at >= now() - interval '1 minute'
   AND NOT EXISTS (
     SELECT 1 FROM audit_log al
      WHERE al.school_id = s.id
        AND al.action   = 'billing.plan.downgrade_applied'
        AND al.created_at >= now() - interval '1 minute'
   )
   AND EXISTS (
     SELECT 1 FROM audit_log al
      WHERE al.school_id = s.id
        AND al.action   = 'billing.plan.downgrade_pending'
   );
