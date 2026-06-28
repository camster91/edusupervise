#!/usr/bin/env bash
# deploy/healthcheck.sh — bash equivalent of /api/health for cron monitoring.
#
# Hits the app's /api/health endpoint over HTTPS, parses the JSON body, and
# exits 0/1/2/3 based on the `status` field:
#   0 = ok
#   1 = degraded (workers stale, redis slow, etc.)
#   2 = down (db unreachable, app not responding)
#   3 = protocol error (non-200, malformed body, TLS failure)
#
# Stdout is one line of structured key=value for log aggregation. Stderr
# has the human-readable detail on failure.
#
# Suitable for /etc/cron.d/edusupervise-healthcheck, healthchecks.io,
# BetterStack, or any other external monitor that just wants the exit
# code.
#
# Env overrides:
#   HEALTHCHECK_URL  default: https://edusupervise.ashbi.ca/api/health
#   TIMEOUT          curl timeout in seconds (default 10)
#   CA_BUNDLE        optional path to a CA bundle (for staging/internal CAs)
#   NO_TLS=1         skip TLS verification (only for dev)
#   VERBOSE=1        print full response body

set -euo pipefail

URL="${HEALTHCHECK_URL:-https://edusupervise.ashbi.ca/api/health}"
TIMEOUT="${TIMEOUT:-10}"
LOG_PREFIX="[healthcheck]"

log()  { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "${LOG_PREFIX}" "$*"; }
die()  { printf '%s %s ERROR: %s\n' "$(date -u +%FT%TZ)" "${LOG_PREFIX}" "$*" >&2; exit 3; }

# ---- 1. Build curl args ----
CURL_ARGS=(
  --silent --show-error
  --max-time "${TIMEOUT}"
  --output /tmp/edusupervise-health.$$.json
  --write-out '%{http_code}'
)
if [[ -n "${CA_BUNDLE:-}" ]]; then
  CURL_ARGS+=(--cacert "${CA_BUNDLE}")
fi
if [[ "${NO_TLS:-0}" == "1" ]]; then
  CURL_ARGS+=(-k)
fi
CURL_ARGS+=("${URL}")

# ---- 2. Hit the endpoint ----
log "GET ${URL}"
http_code="$(curl "${CURL_ARGS[@]}" || true)"
body_file="/tmp/edusupervise-health.$$.json"
trap 'rm -f "${body_file}"' EXIT

if [[ -z "${http_code}" ]]; then
  die "curl failed (no HTTP code); is the host reachable? URL=${URL}"
fi
if [[ "${http_code}" != "200" ]]; then
  log "non-200 response: HTTP ${http_code}; body:"
  [[ -f "${body_file}" ]] && sed 's/^/    /' "${body_file}" >&2
  die "HTTP ${http_code} from ${URL}"
fi

if [[ ! -s "${body_file}" ]]; then
  die "empty body from ${URL}"
fi
body="$(cat "${body_file}")"

if [[ "${VERBOSE:-0}" == "1" ]]; then
  printf '%s\n' "${body}"
fi

# ---- 3. Parse JSON ----
# Prefer jq; fall back to a minimal grep-based parse if not available.
status=""
db=""
redis=""
uptime=""

if command -v jq >/dev/null 2>&1; then
  # `|| true` so a malformed body doesn't trip set -e before we get a chance
  # to die() with a clearer error below.
  status="$(printf '%s' "${body}" | jq -r '.status // empty' 2>/dev/null || true)"
  db="$(printf '%s' "${body}"    | jq -r '.db // empty'     2>/dev/null || true)"
  redis="$(printf '%s' "${body}"  | jq -r '.redis // empty'  2>/dev/null || true)"
  uptime="$(printf '%s' "${body}" | jq -r '.uptime_s // empty' 2>/dev/null || true)"
  workers_count="$(printf '%s' "${body}" | jq -r '.workers | length // 0' 2>/dev/null || echo 0)"
else
  # Fallback: extract a few fields with sed. Less safe but works on minimal images.
  status="$(printf '%s' "${body}" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  db="$(printf '%s' "${body}"    | sed -nE 's/.*"db"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'    | head -n1)"
  redis="$(printf '%s' "${body}"  | sed -nE 's/.*"redis"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
  uptime="$(printf '%s' "${body}" | sed -nE 's/.*"uptime_s"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n1)"
  workers_count="$(printf '%s' "${body}" | grep -o '"workers":\[[^]]*\]' | grep -o '{' | wc -l | tr -d ' ')"
fi

# ---- 4. Decide ----
# Status field is canonical; db/redis/workers inform human diagnostics.
case "${status}" in
  ok)
    log "ok url=${URL} status=${status} db=${db} redis=${redis} workers=${workers_count} uptime_s=${uptime}"
    exit 0
    ;;
  degraded)
    log "DEGRADED url=${URL} status=${status} db=${db} redis=${redis} workers=${workers_count}" >&2
    [[ "${VERBOSE:-0}" == "1" ]] && printf '%s\n' "${body}" >&2
    exit 1
    ;;
  down)
    log "DOWN url=${URL} status=${status} db=${db} redis=${redis} workers=${workers_count}" >&2
    [[ "${VERBOSE:-0}" == "1" ]] && printf '%s\n' "${body}" >&2
    exit 2
    ;;
  "")
    die "could not parse status field from response: ${body}"
    ;;
  *)
    die "unexpected status value: '${status}' (full body: ${body})"
    ;;
esac
