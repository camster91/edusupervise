-- 01-roles.sql — runs as edusupervise_owner (POSTGRES_USER) on first container
-- boot. Creates the runtime + system roles and grants the right perms.
--
-- Why this is separate from 02-schema.sql: it must run BEFORE schema creation
-- so subsequent GRANT statements (which can target either role on system-only
-- tables like stripe_events, worker_heartbeats, outbox, plan_limits) are
-- effective from the moment tables exist. The runtime + system passwords are
-- injected from the docker-compose environment (EDUSUPERVISE_RUNTIME_PASSWORD
-- / EDUSUPERVISE_SYSTEM_PASSWORD) via psql `\set` shell substitution.
--
-- Runtime role (web container): does NOT own tables, NO BYPASSRLS, so FORCE
-- ROW LEVEL SECURITY actually enforces policies against it.
--
-- System role (worker + cron + webhook handlers): NO superuser, BUT has
-- BYPASSRLS so it can write system-only tables (stripe_events,
-- worker_heartbeats, audit_log for system actions) without per-row grants.
-- Defensive: the worker still sets `app.school_id` per transaction to match
-- runtime behavior on tenant tables.

\set ON_ERROR_STOP on
\set RUNTIME_PASSWORD `echo "$EDUSUPERVISE_RUNTIME_PASSWORD"`
\set SYSTEM_PASSWORD  `echo "$EDUSUPERVISE_SYSTEM_PASSWORD"`
\set DB_NAME          `echo "$POSTGRES_DB"`

-- Stage the passwords as session-scoped GUCs so we can read them inside
-- the DO block below. psql variable interpolation (`:'name'`) does NOT
-- happen inside dollar-quoted strings (`$$ ... $$`), so we can't use
-- `:'RUNTIME_PASSWORD'` directly inside the DO block. set_config +
-- current_setting is the standard workaround.
SELECT set_config('edusupervise.runtime_pw', :'RUNTIME_PASSWORD', false);
SELECT set_config('edusupervise.system_pw',  :'SYSTEM_PASSWORD',  false);

-- CREATE ROLE only (no grants yet — tables don't exist on first run).
-- Idempotent: skip if the role already exists (e.g. second container boot).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_runtime') THEN
    EXECUTE format(
      'CREATE ROLE edusupervise_runtime WITH LOGIN PASSWORD %L',
      current_setting('edusupervise.runtime_pw', true)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_system') THEN
    EXECUTE format(
      'CREATE ROLE edusupervise_system WITH LOGIN PASSWORD %L BYPASSRLS',
      current_setting('edusupervise.system_pw', true)
    );
  END IF;
END
$$;

-- Connect + schema usage so both roles can land in the DB and read/write
-- once tables exist. Per-table GRANTs are in 02-schema.sql (after CREATE TABLE).
GRANT CONNECT ON DATABASE :"DB_NAME" TO edusupervise_runtime, edusupervise_system;
GRANT USAGE   ON SCHEMA public      TO edusupervise_runtime, edusupervise_system;

-- Idempotency: make the role statements safe to re-run (e.g. after a
-- partial init where the role was created but the GRANTs failed).
ALTER ROLE edusupervise_runtime NOINHERIT;
ALTER ROLE edusupervise_system  NOINHERIT;