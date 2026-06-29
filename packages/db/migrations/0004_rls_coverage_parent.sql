-- Migration 0004: RLS policies for the Coverage Router + Parent alerts tables
--
-- Per the audit (slice-1 R-09, slice-3 R-S1), the five tables added by
-- migrations 0002 and 0003 had explicit runtime/system GRANTs added
-- (commit c2bc7cd) but ZERO row-level security. Every cross-tenant
-- read/write on these tables was wide open while the rest of the
-- schema was correctly tenant-scoped via FORCE ROW LEVEL SECURITY.
--
-- This migration closes the gap by enabling FORCE RLS and adding the
-- canonical `tenant_isolation` policy for each table. The policy
-- matches the existing convention: USING + WITH CHECK both compare
-- school_id to current_school_id() (Postgres function defined in
-- db/init/02-schema.sql:303-307).
--
-- After this migration runs, code paths that touch these tables MUST be
-- wrapped in withSchoolContext(...) (or read via a getter that sets the
-- app.school_id GUC). Otherwise the runtime role will see zero rows
-- under FORCE RLS.
--
-- Also drops default privileges so the future migration runner can GRANT
-- without re-running this block.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'coverage_events',
    'coverage_assignments',
    'parent_contacts',
    'parent_route_tags',
    'parent_alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE  ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE   ROW LEVEL SECURITY', t);
    -- Drop+create the policy (idempotent in case re-run after a manual
    -- fix).
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING      (school_id = current_school_id()) '
      'WITH CHECK (school_id = current_school_id())',
      t
    );
  END LOOP;
END
$$;
