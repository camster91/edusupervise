-- Migration: 0017_audit_log_immutable
-- Purpose:   Make audit_log DB-enforced append-only. Audit 2026-07-22 P1-1.
--
-- Why this matters:
--   audit_log records compliance-relevant actions (coverage.accept /
--   coverage.decline / coverage.broadcast / school.rename /
--   school.plan_change). The runtime role (edusupervise_runtime) does
--   not have BYPASSRLS, but nothing at the SQL layer prevented a
--   compromised code path from issuing UPDATE / DELETE on audit_log.
--   The only defense today is convention ("we only ever INSERT via
--   recordAudit"). This migration makes the append-only invariant
--   DB-enforced.
--
-- Defense layers:
--   1. RLS enabled + forced on audit_log. The runtime role's UPDATE /
--      DELETE / SELECT policies all block. Only INSERT is allowed.
--   2. BEFORE UPDATE OR DELETE trigger raises an exception so even the
--      owner role cannot quietly mutate rows. The retention/archive
--      cron that the original docstring alluded to (audit.server.ts:6)
--      can be added later — until then, nothing rewrites history.
--   3. REVOKE UPDATE, DELETE on audit_log FROM edusupervise_runtime.
--
-- Operational impact:
--   - recordAudit() (apps/web/server/audit.server.ts) keeps working —
--     it INSERTs only.
--   - The audit-export route (apps/web/app/routes/api.billing.audit-export[.csv].tsx)
--     reads via the system role (BYPASSRLS), which still passes the
--     SELECT policy `app.is_system = on`. No app code change needed.
--   - If you ever want to delete/archive audit rows, you must use a
--     privileged role that bypasses RLS (e.g. the owner / superuser)
--     AND temporarily disable the trigger. Document the procedure in
--     docs/runbooks/audit-retention.md before doing so.

BEGIN;

-- 1. RLS + policies
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_insert ON audit_log;
DROP POLICY IF EXISTS audit_log_select ON audit_log;
DROP POLICY IF EXISTS audit_log_no_update ON audit_log;
DROP POLICY IF EXISTS audit_log_no_delete ON audit_log;

CREATE POLICY audit_log_insert ON audit_log
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY audit_log_select ON audit_log
  FOR SELECT
  USING (current_setting('app.is_system', true) = 'on');

CREATE POLICY audit_log_no_update ON audit_log
  FOR UPDATE
  USING (false);

CREATE POLICY audit_log_no_delete ON audit_log
  FOR DELETE
  USING (false);

-- 2. Defense-in-depth trigger. Even the owner role (which bypasses
--    RLS) cannot UPDATE or DELETE. The only escape hatch is to ALTER
--    TABLE ... DISABLE TRIGGER audit_log_immutable, which leaves a
--    visible audit trail in the migration log.
CREATE OR REPLACE FUNCTION audit_log_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; UPDATE/DELETE is not permitted (table=%, op=%)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501'; -- insufficient_privilege
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable_guard();

-- 3. Revoke privileges the runtime role never needs.
--    Note: the runtime role already lacks BYPASSRLS, but explicit
--    REVOKE makes the invariant clear in role audits.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_runtime') THEN
    REVOKE UPDATE, DELETE ON audit_log FROM edusupervise_runtime;
  END IF;
END $$;

COMMIT;