#!/usr/bin/env bash
# deploy/install.sh — one-shot install of edusupervise on a fresh VPS.
#
# Run as root (or with sudo). The script:
#   1. Creates /root/edusupervise-secrets/ (idempotent).
#   2. Generates three Postgres role passwords if missing
#      (owner / runtime / system) using openssl rand.
#   3. Prompts for: SESSION_SECRET, BETTER_AUTH_SECRET, RESEND_*,
#      TWILIO_*, STRIPE_*, APP_URL, LOG_LEVEL, and optional BACKUP_OFFSITE.
#   4. Writes /root/edusupervise-secrets/.env and postgres_password.txt.
#   5. Runs `docker compose -f docker/docker-compose.yml up -d --build`.
#   6. Waits for postgres to be healthy, then runs db migrations as
#      the owner role (runtime can't CREATE TABLE).
#   7. Prints success and the cron entry to install for daily backups.
#
# Idempotent: re-running with an existing .env preserves current values
# and only prompts for keys that are missing or empty. To start over,
# pass --reset (deletes .env + postgres_password.txt first) or remove
# those two files manually.
#
# Flags:
#   --non-interactive  Generate random secrets, skip prompts that need
#                      real provider keys. Provider keys get empty
#                      defaults (provider defaults to "mock" if unset).
#                      Use for CI/dev/sandbox.
#   --reset            Delete .env + postgres_password.txt before running.
#   --repo-dir DIR     Path to the edusupervise checkout (default /opt/edusupervise).
#   --skip-migrate     Don't run db migrations (use when DB is already migrated).
#   --skip-build       Don't rebuild images (`docker compose up -d` with cache).
#   --dry-run          Print what would be done; make no changes.
#
# Exit codes: 0 = success, 1 = unhandled error, 2 = bad CLI args.

set -euo pipefail

# ---- Defaults ----
REPO_DIR="${REPO_DIR:-/opt/edusupervise}"
COMPOSE_FILE="docker/docker-compose.yml"
SECRETS_DIR="${SECRETS_DIR:-/root/edusupervise-secrets}"
PASSWORD_LENGTH=32
NON_INTERACTIVE=0
RESET=0
SKIP_MIGRATE=0
SKIP_BUILD=0
DRY_RUN=0
PG_HEALTH_TIMEOUT="${PG_HEALTH_TIMEOUT:-120}"   # seconds

# ---- Helpers ----
log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# Always-on, even under -e. Use for paths or values that may legitimately be
# empty (e.g. the user wants SMS_PROVIDER=mock and no Twilio creds).
gen_password() {
  # 32 chars of base64 (url-safe), no padding.
  openssl rand -base64 "${PASSWORD_LENGTH}" | tr -d '=+/' | cut -c1-"${PASSWORD_LENGTH}"
}

# Render KEY=VALUE with proper quoting for .env. Uses single-quote wrapping
# with embedded single-quote escaping, which .env parsers (docker compose,
# bash `set -a; source`) handle correctly.
env_escape() {
  local v="$1"
  v="${v//\'/\'\\\'\'}"   # ' -> '"'"'
  printf "'%s'" "${v}"
}

# write_env_key <path> <key> <value>
write_env_key() {
  local path="$1" key="$2" value="$3"
  local escaped
  escaped="$(env_escape "${value}")"
  if [[ -f "${path}" ]] && grep -qE "^${key}=" "${path}"; then
    # In-place replace the existing line.
    local tmp="${path}.tmp"
    awk -v k="${key}" -v v="${key}=${escaped}" '
      BEGIN { FS="="; OFS="=" }
      $0 ~ "^"k"=" { print v; next }
      { print }
    ' "${path}" > "${tmp}" && mv "${tmp}" "${path}"
  else
    printf '%s=%s\n' "${key}" "${escaped}" >> "${path}"
  fi
}

# Load existing .env into a temp file we can read. We do NOT use
# `set -a; source` here because that would pollute this script's env
# with values that include dollar signs (Stripe keys, etc.) and we
# need to preserve quoting exactly.
load_existing_env() {
  local path="$1"
  [[ -f "${path}" ]] || return 0
  # Use a subshell with -a so we don't pollute this script's variables.
  ( set -a; # shellcheck disable=SC1090
    source "${path}"; set +a
    # Print each as KEY=escaped-value for re-parsing.
    compgen -A variable | while read -r k; do
      [[ "${k}" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
      v="${!k}"
      printf '%s=%s\n' "${k}" "$(env_escape "${v}")"
    done
  )
}

# Read a value from an existing .env without sourcing it. Returns empty
# if the key isn't there.
read_env_key() {
  local path="$1" key="$2"
  [[ -f "${path}" ]] || { echo ""; return; }
  # Match KEY= at line start; capture everything after `=`.
  sed -nE "s/^${key}='(.*)'$/\\1/p; s/^${key}=(.*)$/\\1/p" "${path}" \
    | tail -n1 \
    | sed -e "s/'\\\\''/'/g"
}

prompt_secret() {
  # prompt_secret <key> <default> <allow_empty>
  local key="$1" default="${2-}" allow_empty="${3:-0}"
  if (( NON_INTERACTIVE )); then
    if [[ -n "${default}" ]]; then
      printf '%s' "${default}"
    else
      printf ''
    fi
    return
  fi
  local current=""
  current="$(read_env_key "${ENV_PATH}" "${key}")"
  local shown_default=""
  if [[ -n "${current}" ]]; then
    shown_default="[current: ***set***]"
  elif [[ -n "${default}" ]]; then
    shown_default="[default: ${default}]"
  fi
  local prompt="${key} ${shown_default}: "
  local value=""
  while true; do
    if [[ -t 0 ]]; then
      # TTY: use silent read for password-like keys.
      if [[ "${key}" =~ (SECRET|KEY|TOKEN|PASSWORD) ]]; then
        read -r -s -p "${prompt}" value || true
        echo
      else
        read -r -p "${prompt}" value || true
      fi
    else
      # Non-TTY: read a line (CI/dev/null input).
      if IFS= read -r -u 0 value; then :; else value=""; fi
    fi
    # Strip trailing CR (in case stdin is CRLF).
    value="${value%$'\r'}"
    if [[ -z "${value}" ]]; then
      if [[ -n "${current}" ]]; then
        value="${current}"
        break
      elif [[ -n "${default}" ]]; then
        value="${default}"
        break
      elif (( allow_empty == 1 )); then
        value=""
        break
      else
        warn "${key} is required (or pass --non-interactive)"
        continue
      fi
    fi
    break
  done
  printf '%s' "${value}"
}

# ---- Parse args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --reset)           RESET=1; shift ;;
    --repo-dir)        REPO_DIR="$2"; shift 2 ;;
    --skip-migrate)    SKIP_MIGRATE=1; shift ;;
    --skip-build)      SKIP_BUILD=1; shift ;;
    --dry-run)         DRY_RUN=1; NON_INTERACTIVE=1; shift ;;
    -h|--help)
      # Print the script's leading comment block as usage. The block
      # ends at the first blank line after the shebang.
      awk 'NR>1 && /^#!/{exit} NR>1 && /^$/{exit} NR>1{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac
done

ENV_PATH="${SECRETS_DIR}/.env"
PW_FILE="${SECRETS_DIR}/postgres_password.txt"

# ---- 1. Preflight ----
log "preflight checks"
for cmd in docker openssl; do
  command -v "${cmd}" >/dev/null 2>&1 || die "${cmd} is required but not installed"
done
docker compose version >/dev/null 2>&1 || die "docker compose v2 (subcommand) is required"
[[ -d "${REPO_DIR}" ]] || die "repo not found at ${REPO_DIR} (use --repo-dir)"
[[ -f "${REPO_DIR}/${COMPOSE_FILE}" ]] || die "${COMPOSE_FILE} not found in ${REPO_DIR}"

# ---- 2. Reset (optional) ----
if (( RESET )); then
  log "resetting ${ENV_PATH} and ${PW_FILE}"
  (( DRY_RUN )) || rm -f "${ENV_PATH}" "${PW_FILE}"
fi

# ---- 3. Create secrets dir ----
if (( DRY_RUN )); then
  log "[dry-run] would mkdir -p ${SECRETS_DIR} (mode 0700)"
else
  mkdir -p -m 0700 "${SECRETS_DIR}"
fi
# Sanity: in dry-run, the secrets dir may not exist yet. Make sure
# the path we use for .env is writable.
if (( DRY_RUN )) && [[ ! -d "${SECRETS_DIR}" ]]; then
  mkdir -p -m 0700 "${SECRETS_DIR}"
fi

# ---- 4. Generate or read passwords ----
# Always three: owner (POSTGRES_PASSWORD), runtime, system. We keep the owner
# password in BOTH .env (as POSTGRES_PASSWORD, for migration scripts) and in
# postgres_password.txt (for the docker secret mount).
if [[ -f "${PW_FILE}" ]] && [[ -s "${PW_FILE}" ]]; then
  OWNER_PW="$(cat "${PW_FILE}")"
  log "using existing postgres owner password from ${PW_FILE}"
else
  OWNER_PW="$(gen_password)"
  log "generated new postgres owner password (32 chars)"
fi

# Runtime / system passwords go in .env only.
RUNTIME_PW_DEFAULT=""
SYSTEM_PW_DEFAULT=""
if [[ -f "${ENV_PATH}" ]]; then
  RUNTIME_PW_DEFAULT="$(read_env_key "${ENV_PATH}" EDUSUPERVISE_RUNTIME_PASSWORD)"
  SYSTEM_PW_DEFAULT="$(read_env_key "${ENV_PATH}" EDUSUPERVISE_SYSTEM_PASSWORD)"
fi
RUNTIME_PW="${RUNTIME_PW_DEFAULT:-$(gen_password)}"
SYSTEM_PW="${SYSTEM_PW_DEFAULT:-$(gen_password)}"

# ---- 5. Prompt for other secrets ----
log "collecting secrets (use Ctrl-C to abort)"

# Pre-fill the .env header (or write it fresh).
if [[ ! -f "${ENV_PATH}" ]]; then
  if (( DRY_RUN )); then
    log "[dry-run] would create ${ENV_PATH} with header"
  else
    cat > "${ENV_PATH}" <<'EOF'
# edusupervise production secrets — chmod 0600, never commit.
# Regenerate with: deploy/install.sh --reset
EOF
    chmod 0600 "${ENV_PATH}"
  fi
fi

# If a value already exists in .env, prompt_secret reuses it on Enter.
# If empty, it falls back to the default we pass.
write_kv() {
  local key="$1" default="$2" allow_empty="${3:-0}"
  local value
  value="$(prompt_secret "${key}" "${default}" "${allow_empty}")"
  if (( DRY_RUN )); then
    log "[dry-run] would set ${key}"
    return
  fi
  write_env_key "${ENV_PATH}" "${key}" "${value}"
  log "  ${key} = ***set***"
}

# Always write the runtime + system passwords to .env (the postgres
# container reads these via env_file and substitutes them into
# 01-roles.sql via psql `\set` backticks).
#
# The OWNER password does NOT go in .env — it lives ONLY in
# postgres_password.txt and is mounted into the postgres container as
# /run/secrets/postgres_password, read via POSTGRES_PASSWORD_FILE. If
# both POSTGRES_PASSWORD and POSTGRES_PASSWORD_FILE are set, the
# postgres entrypoint refuses to start with "both POSTGRES_PASSWORD
# and POSTGRES_PASSWORD_FILE are set (but are exclusive)".
#
# The script still keeps OWNER_PW in a bash variable for the migration
# step (line ~378) which builds DATABASE_URL directly via docker run -e.
write_kv EDUSUPERVISE_RUNTIME_PASSWORD  "${RUNTIME_PW}"
write_kv EDUSUPERVISE_SYSTEM_PASSWORD   "${SYSTEM_PW}"

# Export for docker compose interpolation. The compose file references
# ${EDUSUPERVISE_SECRETS_DIR} (env_file path) and ${EDUSUPERVISE_*_PASSWORD}
# (DATABASE_URL interpolation) at compose-parse time. Without exporting
# these from this script, docker compose would interpolate empty strings
# (DATABASE_URL becomes "postgres://runtime:@postgres:..." — fails auth)
# or fall back to /root/edusupervise-secrets even when SECRETS_DIR was
# overridden. All other keys (RESEND_*, STRIPE_*, etc.) are loaded inside
# the container via env_file, so they don't need to be exported here.
export EDUSUPERVISE_SECRETS_DIR="${SECRETS_DIR}"
export EDUSUPERVISE_RUNTIME_PASSWORD="${RUNTIME_PW}"
export EDUSUPERVISE_SYSTEM_PASSWORD="${SYSTEM_PW}"

# Auth secrets — must be 32+ bytes of randomness.
SESSION_SECRET_DEFAULT=""
BETTER_AUTH_SECRET_DEFAULT=""
if [[ -f "${ENV_PATH}" ]]; then
  SESSION_SECRET_DEFAULT="$(read_env_key "${ENV_PATH}" SESSION_SECRET)"
  BETTER_AUTH_SECRET_DEFAULT="$(read_env_key "${ENV_PATH}" BETTER_AUTH_SECRET)"
fi
SESSION_SECRET_DEFAULT="${SESSION_SECRET_DEFAULT:-$(gen_password)}"
BETTER_AUTH_SECRET_DEFAULT="${BETTER_AUTH_SECRET_DEFAULT:-$(gen_password)}"
write_kv SESSION_SECRET       "${SESSION_SECRET_DEFAULT}"
write_kv BETTER_AUTH_SECRET   "${BETTER_AUTH_SECRET_DEFAULT}"

# Email (Resend).
write_kv RESEND_API_KEY       "" 1
write_kv RESEND_FROM_EMAIL    "noreply@edusupervise.ashbi.ca"

# SMS (Twilio).
write_kv TWILIO_ACCOUNT_SID   "" 1
write_kv TWILIO_AUTH_TOKEN    "" 1
write_kv TWILIO_FROM_NUMBER   "+15555550100" 1

# Billing (Stripe).
write_kv STRIPE_SECRET_KEY      "" 1
write_kv STRIPE_WEBHOOK_SECRET  "" 1
write_kv STRIPE_PRICE_PRO       "" 1
write_kv STRIPE_PRICE_SCHOOL    "" 1

# App.
write_kv APP_URL              "https://edusupervise.ashbi.ca"
write_kv LOG_LEVEL            "info"
write_kv EMAIL_PROVIDER       "resend"
write_kv SMS_PROVIDER         "twilio"
write_kv BILLING_PROVIDER     "stripe"

# Backup (optional).
write_kv BACKUP_OFFSITE       "" 1

# ---- 6. Write postgres_password.txt for the docker secret ----
if (( DRY_RUN )); then
  log "[dry-run] would write ${PW_FILE} (chmod 0600)"
else
  printf '%s' "${OWNER_PW}" > "${PW_FILE}"
  chmod 0600 "${PW_FILE}"
  log "wrote ${PW_FILE}"
fi

# ---- 7. Sanity-check required values ----
# Note: POSTGRES_PASSWORD is intentionally NOT in this list — it lives
# only in postgres_password.txt (the docker secret mount). See the
# comment above the write_kv calls for EDUSUPERVISE_*_PASSWORD for why.
if (( ! DRY_RUN )); then
  for k in EDUSUPERVISE_RUNTIME_PASSWORD EDUSUPERVISE_SYSTEM_PASSWORD \
           SESSION_SECRET BETTER_AUTH_SECRET APP_URL; do
    v="$(read_env_key "${ENV_PATH}" "${k}")"
    [[ -n "${v}" ]] || die "${k} is empty in ${ENV_PATH}; rerun and supply a value"
  done
  # Verify the OWNER password file was written and is non-empty.
  [[ -s "${PW_FILE}" ]] || die "${PW_FILE} is empty; cannot proceed"
fi

# ---- 8. Bring up the stack ----
cd "${REPO_DIR}"
if (( DRY_RUN )); then
  log "[dry-run] would run: docker compose -f ${COMPOSE_FILE} up -d --build"
else
  log "bringing up the stack (this may take a few minutes on first run)"
  if (( SKIP_BUILD )); then
    docker compose -f "${COMPOSE_FILE}" up -d
  else
    docker compose -f "${COMPOSE_FILE}" up -d --build
  fi
fi

# ---- 9. Wait for postgres to be healthy ----
if (( DRY_RUN )); then
  log "[dry-run] would wait for postgres healthcheck (timeout ${PG_HEALTH_TIMEOUT}s)"
else
  log "waiting for postgres healthcheck (timeout ${PG_HEALTH_TIMEOUT}s)"
  deadline=$(( $(date +%s) + PG_HEALTH_TIMEOUT ))
  while true; do
    state="$(docker inspect -f '{{.State.Health.Status}}' edusupervise-postgres-1 2>/dev/null || echo unknown)"
    if [[ "${state}" == "healthy" ]]; then
      log "postgres is healthy"
      break
    fi
    if (( $(date +%s) >= deadline )); then
      die "postgres did not become healthy within ${PG_HEALTH_TIMEOUT}s; \
check 'docker logs edusupervise-postgres-1'"
    fi
    sleep 2
  done
fi

# ---- 10. Run migrations as the owner role ----
if (( SKIP_MIGRATE )); then
  log "skipping migrations (--skip-migrate)"
elif (( DRY_RUN )); then
  log "[dry-run] would run migrations against the owner role"
else
  log "running db migrations"
  # The web container has the full repo + drizzle-kit. We override DATABASE_URL
  # to the owner URL so drizzle can CREATE/ALTER TABLE.
  docker compose -f "${COMPOSE_FILE}" run --rm \
    -e "DATABASE_URL=postgres://edusupervise_owner:${OWNER_PW}@postgres:5432/edusupervise" \
    web pnpm --filter @edusupervise/db migrate
fi

# ---- 11. Done ----
log ""
log "============================================================"
log "  edusupervise installed"
log "============================================================"
log ""
log "Next steps:"
log "  1. Confirm the app is up:"
log "       curl -fsS https://edusupervise.ashbi.ca/api/health"
log "  2. Install the daily backup cron (copy this into /etc/cron.d/edusupervise-backup):"
log "       0 3 * * * root BACKUP_OFFSITE='${BACKUP_OFFSITE:-user@backup.ashbi.ca:/backups/edusupervise/}' \\"
log "         /opt/edusupervise/deploy/backup.sh >> /var/log/edusupervise-backup.log 2>&1"
log "  3. Drop the Traefik dynamic config on the host:"
log "       sudo cp /opt/edusupervise/deploy/traefik/edusupervise.yml \\"
log "            /opt/traefik/dynamic/routers/edusupervise.yml"
log "  4. Verify reminders fire end-to-end (see docs/runbooks/incident-debug.md)."
log ""
log "Secrets are at ${SECRETS_DIR} (mode 0700, files 0600)."
log "Re-run this script any time to add/rotate values; existing keys are kept."
