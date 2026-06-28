-- Nightly audit log retention prune.
-- Run from the `cron` container in compose (alpine + postgresql16-client).
-- Honors per-plan retention from plan_limits.

DELETE FROM audit_log
WHERE (school_id, created_at) IN (
  SELECT a.school_id, a.created_at
  FROM audit_log a
  JOIN schools s ON a.school_id = s.id
  JOIN plan_limits pl ON s.plan = pl.plan
  WHERE a.created_at < now() - (pl.audit_retention_days * interval '1 day')
);
