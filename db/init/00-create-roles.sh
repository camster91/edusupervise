#!/bin/sh
# 00-create-roles.sh — runs as POSTGRES_USER (edusupervise_owner superuser) on
# first container boot. Creates the runtime + system roles with passwords
# supplied via compose environment, then grants the right perms.
#
# Runtime role: web container. Does NOT own tables, so FORCE ROW LEVEL SECURITY
# applies.
#
# System role: worker + cron + webhook handlers. Has BYPASSRLS for system-only
# tables (stripe_events, worker_heartbeats, audit_log for system actions).

set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_runtime') THEN
    CREATE ROLE edusupervise_runtime WITH LOGIN PASSWORD '${EDUSUPERVISE_RUNTIME_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_system') THEN
    CREATE ROLE edusupervise_system WITH LOGIN PASSWORD '${EDUSUPERVISE_SYSTEM_PASSWORD}' BYPASSRLS;
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO edusupervise_runtime;
GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO edusupervise_system;
GRANT USAGE ON SCHEMA public TO edusupervise_runtime;
GRANT USAGE ON SCHEMA public TO edusupervise_system;

DO \$\$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO edusupervise_runtime', r.tablename);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO edusupervise_system', r.tablename);
  END LOOP;
END
\$\$;

DO \$\$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO edusupervise_runtime', r.sequence_name);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO edusupervise_system', r.sequence_name);
  END LOOP;
END
\$\$;
EOSQL
