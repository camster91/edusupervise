#!/usr/bin/env bash
# deploy/backup.sh — daily pg_dump + offsite rsync + retention for edusupervise.
#
# Usage (typical, from VPS host):
#   DATABASE_URL=postgres://edusupervise_owner:...@localhost:5432/edusupervise \
#   BACKUP_OFFSITE=user@backup.ashbi.ca:/backups/edusupervise/ \
#   /opt/edusupervise/deploy/backup.sh
#
# Cron entry (already installed by install.sh):
#   0 3 * * * root /opt/edusupervise/deploy/backup.sh \
#     >> /var/log/edusupervise-backup.log 2>&1
#
# Behavior:
#   1. Dumps `edusupervise` to /data/backups/edusupervise-YYYY-MM-DD.dump
#      using either DATABASE_URL (preferred) or `docker exec` into the
#      postgres container as the owner role.
#   2. If BACKUP_OFFSITE is set, rsyncs the dump there.
#   3. Retains last 30 daily + 12 monthly (1st-of-month) dumps locally.
#      Offsite target is NOT pruned by this script (run a separate cron
#      on the offsite host to mirror its own retention policy).
#
# Idempotent: skips a day that already has a dump. Set FORCE=1 to overwrite.
# Errors are loud (set -e) and logged to stderr; cron captures both.
#
# Restore procedure: docs/runbooks/restore.md.

set -euo pipefail

# ---- Config (env-overridable) ----
COMPOSE_PROJECT="${COMPOSE_PROJECT:-edusupervise}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
OFFSITE_TARGET="${BACKUP_OFFSITE:-}"
RETENTION_DAILY="${RETENTION_DAILY:-30}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-12}"
SECRETS_DIR="${SECRETS_DIR:-/root/edusupervise-secrets}"
LOG_PREFIX="[backup]"

# ---- Helpers ----
log()  { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "${LOG_PREFIX}" "$*"; }
die()  { printf '%s %s ERROR: %s\n' "$(date -u +%FT%TZ)" "${LOG_PREFIX}" "$*" >&2; exit 1; }

# Portable date-to-epoch: GNU `date -d` (Linux) first, BSD `date -j -f` (macOS)
# fallback so the script can be dry-run on a Mac dev box.
date_to_epoch() {
  local d="$1"
  date -d "${d}" +%s 2>/dev/null \
    || date -j -f '%Y-%m-%d' "${d}" +%s 2>/dev/null
}

# ---- 1. Optionally source secrets for env vars (BACKUP_OFFSITE etc.) ----
if [[ -f "${SECRETS_DIR}/.env" && -z "${BACKUP_OFFSITE:-}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${SECRETS_DIR}/.env"; set +a
  OFFSITE_TARGET="${BACKUP_OFFSITE:-${OFFSITE_TARGET}}"
fi

# ---- 2. Sanity checks ----
command -v pg_dump >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 \
  || die "neither pg_dump nor docker is available; install postgresql-client or docker"

# Audit 2026-07-22 P1-6: backups contain user / auth / tenant data and
# must NOT be world-readable on disk or over the wire. Set a strict
# umask for this script's process so every file we create (including
# the dump itself) is owner-only, regardless of the calling shell's
# inherited umask.
umask 077

# Create the backup directory with restrictive permissions in case it
# doesn't exist yet. The mode 0700 means only the owner can read or
# traverse, which is what we want for a directory holding database
# dumps.
install -d -m 0700 "${BACKUP_DIR}"

# ---- 3. Run pg_dump ----
DATE=$(date -u +%F)
DUMP_FILE="${BACKUP_DIR}/edusupervise-${DATE}.dump"
TMP_FILE="${DUMP_FILE}.tmp"

if [[ -f "${DUMP_FILE}" && "${FORCE:-0}" != "1" ]]; then
  log "dump for ${DATE} already exists at ${DUMP_FILE}; skipping (set FORCE=1 to overwrite)"
else
  log "dumping database -> ${DUMP_FILE}"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    # Parse the password from the URL (libpq handles URLs natively, but PGPASSWORD
    # avoids any ambiguity for non-libpq code paths).
    PGPASSWORD="$(printf '%s' "${DATABASE_URL}" \
      | sed -E 's#^postgres(ql)?://[^:]+:([^@]+)@.*#\2#')"
    export PGPASSWORD
    pg_dump -Fc -d "${DATABASE_URL}" -f "${TMP_FILE}"
  else
    # Fall back to docker exec as the owner role. We use the container's
    # internal unix socket; no password needed.
    PG_CONT="${COMPOSE_PROJECT}-postgres-1"
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${PG_CONT}"; then
      die "postgres container ${PG_CONT} not running and DATABASE_URL unset; \
start the stack or export DATABASE_URL"
    fi
    docker exec -i "${PG_CONT}" \
      pg_dump -Fc -U edusupervise_owner edusupervise > "${TMP_FILE}"
  fi
  # Atomic move into place so a failed dump never leaves a partial file.
  mv -f "${TMP_FILE}" "${DUMP_FILE}"
  log "dump complete: $(du -h "${DUMP_FILE}" | cut -f1) ($(stat -c %s "${DUMP_FILE}" 2>/dev/null || stat -f %z "${DUMP_FILE}") bytes)"
fi

# ---- 4. Rsync to offsite ----
if [[ -n "${OFFSITE_TARGET}" ]]; then
  log "syncing ${DUMP_FILE} -> ${OFFSITE_TARGET}"
  # Audit 2026-07-22 P1-6: chmod=go-rwx (not go=r) so the offsite copy
  # is also owner-only. The receiver may apply umask differently; we
  # pin the file mode at the sender side.
  rsync -az --partial --no-perms --chmod=u=rw,go= "${DUMP_FILE}" "${OFFSITE_TARGET}/"
  log "offsite sync complete"
else
  log "BACKUP_OFFSITE not set; skipping offsite rsync (BACKUP_DIR is local-only)"
fi

# ---- 5. Apply retention: 30 daily + 12 monthly ----
# Rule:
#   - All files dated within the last RETENTION_DAILY days: KEEP.
#   - Files older than that but matching YYYY-MM-01 (1st of month) and
#     within the last RETENTION_MONTHLY months: KEEP.
#   - Everything else: DELETE.
# This is computed relative to today, not to the file's own date, so the
# window slides forward each run.
log "applying retention: ${RETENTION_DAILY} daily, ${RETENTION_MONTHLY} monthly"
now_epoch=$(date +%s)
daily_cutoff=$((RETENTION_DAILY * 86400))
monthly_cutoff=$((RETENTION_MONTHLY * 31 * 86400))  # approx, generous
kept=0
deleted=0
shopt -s nullglob
for f in "${BACKUP_DIR}"/edusupervise-????-??-??.dump; do
  fname=$(basename "${f}")
  file_date="${fname#edusupervise-}"
  file_date="${file_date%.dump}"
  # Sanity: skip anything that doesn't look like a YYYY-MM-DD stamp.
  [[ "${file_date}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  file_epoch=$(date_to_epoch "${file_date}") || continue
  age=$((now_epoch - file_epoch))

  keep=0
  if (( age <= daily_cutoff )); then
    keep=1
  elif [[ "${file_date:8:2}" == "01" ]] && (( age <= monthly_cutoff )); then
    keep=1
  fi

  if (( keep == 1 )); then
    kept=$((kept + 1))
  else
    log "deleting ${fname} (age=$((age / 86400))d)"
    rm -f "${f}"
    deleted=$((deleted + 1))
  fi
done
shopt -u nullglob
log "retention done: kept=${kept} deleted=${deleted}"

# ---- 6. Emit Prometheus freshness stamp (audit B12) ----
# /var/lib/node_exporter/edusupervise_backup_last_success is read
# by apps/web/app/routes/metrics.tsx on every /metrics scrape and
# surfaced as the `backup_last_success_timestamp_seconds` gauge.
# The directory is the textfile-collector convention so a sibling
# node_exporter could also pick it up later (the file is one
# timestamp per line; the web route reads the first).
STAMP_DIR="/var/lib/node_exporter"
STAMP_FILE="${STAMP_DIR}/edusupervise_backup_last_success"
mkdir -p "${STAMP_DIR}"
date -u +%s > "${STAMP_FILE}" 2>/dev/null \
  || printf '%s\n' "$(date +%s)" > "${STAMP_FILE}"
log "wrote last-success stamp: ${STAMP_FILE} ($(cat ${STAMP_FILE}))"

log "backup finished OK"
