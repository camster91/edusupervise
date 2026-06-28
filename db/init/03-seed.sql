-- 03-seed.sql — runs as edusupervise_owner on first container boot, AFTER
-- 02-schema.sql. Seeds the global `plan_limits` lookup table per spec
-- section 4.
--
-- NO demo school here. A demo school comes from `pnpm db:seed` (the
-- @edusupervise/db seed.ts script) which is run explicitly after first boot.
-- Production deploys NEVER run db:seed.

\set ON_ERROR_STOP on

-- Idempotent: ON CONFLICT (plan) DO UPDATE so re-running the init script
-- (or rolling forward to a new version) refreshes the limits without
-- duplicating rows. Trial + Free + Pro + School match the spec pricing
-- table verbatim.

INSERT INTO plan_limits
  (plan, max_teachers, max_duties, max_reminders_per_assignment, sms_included, audit_retention_days)
VALUES
  ('trial',  5,   20,  3, false, 14),
  ('free',   3,   10,  1, false, 7),
  ('pro',   50,  500, 10, true,  90),
  ('school', 500, 5000, 50, true, 365)
ON CONFLICT (plan) DO UPDATE SET
  max_teachers                = EXCLUDED.max_teachers,
  max_duties                  = EXCLUDED.max_duties,
  max_reminders_per_assignment = EXCLUDED.max_reminders_per_assignment,
  sms_included                = EXCLUDED.sms_included,
  audit_retention_days        = EXCLUDED.audit_retention_days;