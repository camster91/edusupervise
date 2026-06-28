#!/usr/bin/env bash
# tests/integration/setup-local-postgres.sh — bootstrap a local edusupervise DB
# for the integration tests.
#
# Idempotent. Runs as the macOS user (biancabienaime on this dev box),
# which is a Postgres superuser via Homebrew's postgres@16 install.
# Creates:
#   - roles: edusupervise_owner, edusupervise_runtime, edusupervise_system
#   - database: edusupervise
#   - schema: from db/init/02-schema.sql
#   - plan_limits: from db/init/03-seed.sql
#   - drizzle migrations (0000_init, 0001_brave_gravity — adds auth tables)
#
# Usage:
#   ./tests/integration/setup-local-postgres.sh          # default setup
#   ./tests/integration/setup-local-postgres.sh --reset  # drop & re-create
#
# After setup, the integration tests connect to:
#   - runtime: edusupervise_runtime:testpw@localhost:5432/edusupervise
#   - system:  edusupervise_system:testpw@localhost:5432/edusupervise
#   - owner:   edusupervise_owner:testpw@localhost:5432/edusupervise

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INIT_DIR="$REPO_DIR/db/init"
RESET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Local macOS Homebrew Postgres (user biancabienaime is superuser).
PSQL_USER="$(whoami)"
TEST_PW="testpw"

# Override \set values via psql CLI variables (-v). 01-roles.sql reads
# them via backtick substitution; in psql `-v name=value` puts them in
# the `name` substitution slot. Note: `\set` and `-v` are NOT the same
# — `-v` works with `:'name'` syntax. We use `-v` here.

run_psql() {
  psql -U "$PSQL_USER" -h localhost -d postgres -v ON_ERROR_STOP=1 "$@"
}

create_roles_and_db() {
  echo "==> ensuring edusupervise database + roles exist"

  # Drop + recreate database if --reset.
  if (( RESET )); then
    run_psql -c "DROP DATABASE IF EXISTS edusupervise;" || true
    run_psql -c "DROP ROLE IF EXISTS edusupervise_runtime;" || true
    run_psql -c "DROP ROLE IF EXISTS edusupervise_system;" || true
  fi

  # Roles (idempotent via DO block).
  run_psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_owner') THEN
    CREATE ROLE edusupervise_owner WITH LOGIN SUPERUSER PASSWORD '${TEST_PW}';
  ELSE
    ALTER ROLE edusupervise_owner WITH LOGIN SUPERUSER PASSWORD '${TEST_PW}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_runtime') THEN
    CREATE ROLE edusupervise_runtime WITH LOGIN PASSWORD '${TEST_PW}';
  ELSE
    ALTER ROLE edusupervise_runtime WITH LOGIN PASSWORD '${TEST_PW}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edusupervise_system') THEN
    CREATE ROLE edusupervise_system WITH LOGIN BYPASSRLS PASSWORD '${TEST_PW}';
  ELSE
    ALTER ROLE edusupervise_system WITH LOGIN BYPASSRLS PASSWORD '${TEST_PW}';
  END IF;
END
\$\$;
SQL

  # Database (idempotent).
  if ! run_psql -tAc "SELECT 1 FROM pg_database WHERE datname='edusupervise'" | grep -q 1; then
    run_psql -c "CREATE DATABASE edusupervise OWNER edusupervise_owner;"
  fi

  # Ensure runtime + system can land in the DB.
  run_psql -d edusupervise <<SQL
GRANT CONNECT ON DATABASE edusupervise TO edusupervise_runtime, edusupervise_system;
GRANT USAGE   ON SCHEMA public      TO edusupervise_runtime, edusupervise_system;
SQL
}

run_init_sql() {
  echo "==> running db/init/02-schema.sql (as owner)"

  # 01-roles.sql uses \set with shell backticks to read env vars. We
  # can't easily run it via psql CLI on a local install (the env vars
  # EDUSUPERVISE_RUNTIME_PASSWORD / EDUSUPERVISE_SYSTEM_PASSWORD aren't
  # available). The roles + grants were created above with the same
  # password; skip 01-roles.sql.

  PGPASSWORD="${TEST_PW}" psql -U edusupervise_owner -h localhost -d edusupervise \
    -v ON_ERROR_STOP=1 -f "${INIT_DIR}/02-schema.sql"
  PGPASSWORD="${TEST_PW}" psql -U edusupervise_owner -h localhost -d edusupervise \
    -v ON_ERROR_STOP=1 -f "${INIT_DIR}/03-seed.sql"
}

run_drizzle_migrations() {
  echo "==> running drizzle migrations (as owner)"

  cd "$REPO_DIR"
  DATABASE_URL="postgres://edusupervise_owner:${TEST_PW}@localhost:5432/edusupervise" \
    ./node_modules/.bin/drizzle-kit migrate 2>&1 | tail -20
}

create_roles_and_db
run_init_sql
run_drizzle_migrations

cat <<EOF

==> Done. Test DB is ready.

Connection strings (use these in tests/.env):
  DATABASE_URL=postgres://edusupervise_runtime:${TEST_PW}@localhost:5432/edusupervise
  SYSTEM_DATABASE_URL=postgres://edusupervise_system:${TEST_PW}@localhost:5432/edusupervise
  OWNER_DATABASE_URL=postgres://edusupervise_owner:${TEST_PW}@localhost:5432/edusupervise
  BETTER_AUTH_SECRET=$(openssl rand -base64 32)
  APP_URL=http://localhost:3000
  NODE_ENV=test

Run integration tests:
  cd /Users/biancabienaime/Documents/edusupervise
  pnpm test:integration
EOF