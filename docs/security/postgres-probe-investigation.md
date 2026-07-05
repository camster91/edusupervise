# Postgres user probe investigation (H-1)

On 2026-07-04 03:33 UTC, postgres logged a single FATAL auth failure:
`role "postgres" does not exist`.

This corresponds to a probe (likely automated port scan / vuln scanner) hitting
the exposed Postgres port 5432 on vps.ashbi.ca. The probe used the default
`postgres` username, which doesn't exist on this cluster (only `edusupervise_owner`,
`edusupervise_system`, `edusupervise_runtime` are configured).

**Root cause**: Port 5432 is exposed publicly via firewalld DNAT to another
app's Postgres at 172.16.4.2 — NOT edusupervise's. See commit audit 2026-07-04.

**Action taken**:
- Confirmed edusupervise's Postgres at 172.16.9.2 is NOT externally exposed.
- Flagged the other app's exposure to Cameron as out-of-scope (separate ticket).
- The probe cannot have succeeded against edusupervise's DB.

**Recommendation**: monitor `pg_log` for repeated `FATAL: role "..." does not exist`
patterns. If they spike, it suggests active scanning. Add a cron job that
emails Cameron when > 5 such failures per hour.

**Files grepped (no hits in our code)**:
- `apps/`, `packages/`, `docker/`, `deploy/`, `scripts/`
- Common patterns: `-U postgres`, `-u postgres`, `--user postgres`,
  `POSTGRES_USER=postgres`
- The probe source is external (scanner) not internal config.
