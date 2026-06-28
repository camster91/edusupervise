# Restore runbook

When the database is corrupt, you need to roll back, or you want to verify
a backup actually works, restore from a `pg_dump` file in
`/data/backups/`. This runbook assumes you have:

- A backup file like `/data/backups/edusupervise-2026-06-28.dump` (custom format, `-Fc`).
- The secrets file at `/root/edusupervise-secrets/.env`.
- SSH access to `vps.ashbi.ca` as a user with sudo + docker access.
- A working `docker compose` setup (the stack is currently running OR you
  can start it via `deploy/install.sh`).

> If the stack isn't running at all, start with `deploy/install.sh` first
> (see [install.sh](../../deploy/install.sh) or the success message it
> prints). The restore below assumes the stack is up.

## Why this isn't a one-liner

`pg_dump` does not dump roles. The `edusupervise_runtime` and
`edusupervise_system` roles are created by `db/init/01-roles.sql`
on first container boot. After a `DROP DATABASE` or full rebuild you
must **recreate the roles BEFORE restoring data** — otherwise
`pg_restore` errors out with `role "edusupervise_runtime" does not exist`
and the runtime + system connections from the web/worker containers
will start failing.

The init scripts read `EDUSUPERVISE_RUNTIME_PASSWORD` and
`EDUSUPERVISE_SYSTEM_PASSWORD` from the postgres container's env (via
`psql \set` backtick substitution in `01-roles.sql`). The postgres service
in `docker/docker-compose.yml` loads its env from
`/root/edusupervise-secrets/.env` (via the `env_file` directive), so as
long as `deploy/install.sh` has run once, those vars are present.

The init scripts run in alphabetical order on first boot of a fresh
postgres data directory:

1. **`db/init/01-roles.sql`** — creates `edusupervise_runtime` (no
   superuser, no BYPASSRLS) and `edusupervise_system` (no superuser,
   BYPASSRLS). Grants CONNECT on the database and USAGE on the public
   schema to both roles.
2. **`db/init/02-schema.sql`** — creates every table from spec section 4,
   then runs the per-table ENABLE + FORCE + POLICY loop, then applies
   per-table GRANTs for runtime + system roles.
3. **`db/init/03-seed.sql`** — seeds the `plan_limits` lookup (trial /
   free / pro / school).

These run automatically via the `postgres:16-alpine` entrypoint when
`/data/postgres` is empty. They do NOT run on subsequent boots (the
entrypoint only initializes an empty data directory).

## Restore steps

### 1. Stop the app and worker

Nothing should write to the DB during restore.

```bash
cd /opt/edusupervise  # or wherever the repo is checked out
docker compose -f docker/docker-compose.yml stop web worker cron
```

Leave `postgres` running — we need it to drop/recreate the database.

### 2. Pick the dump file

```bash
ls -lh /data/backups/edusupervise-*.dump | tail -n 5
```

Pick the file you want. The most recent daily is the default; if the
problem is recent data corruption, you may need the one *before* the
incident. The monthly files (1st of each month) keep older snapshots
available for ~12 months.

### 3. Drop and recreate the database

This wipes everything except roles (which are cluster-wide in Postgres).

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -c "DROP DATABASE edusupervise;"
docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -c "CREATE DATABASE edusupervise OWNER edusupervise_owner;"
```

### 4. Recreate the runtime + system roles

Roles live in the cluster (not the DB), so the `DROP DATABASE` above
didn't touch them. But if you're recovering from a *full* cluster
wipe (e.g. a fresh `/data/postgres` directory), the roles are gone.
Either way, running the roles init is idempotent and safe:

```bash
docker compose -f docker/docker-compose.yml exec postgres \
  psql -v ON_ERROR_STOP=1 -U edusupervise_owner -d edusupervise \
    -v EDUSUPERVISE_RUNTIME_PASSWORD="$(grep EDUSUPERVISE_RUNTIME_PASSWORD /root/edusupervise-secrets/.env | cut -d= -f2)" \
    -v EDUSUPERVISE_SYSTEM_PASSWORD="$(grep EDUSUPERVISE_SYSTEM_PASSWORD /root/edusupervise-secrets/.env | cut -d= -f2)" \
    -f /docker-entrypoint-initdb.d/01-roles.sql
```

Or simpler — if you're in a hurry and don't mind re-running the schema
too, blow away `/data/postgres` and restart the postgres container;
the entrypoint will re-run `01-roles.sql`, `02-schema.sql`, and
`03-seed.sql` in order.

```bash
docker compose -f docker/docker-compose.yml stop postgres
rm -rf /data/postgres/*       # ⚠ DESTRUCTIVE: wipes the data directory
docker compose -f docker/docker-compose.yml up -d postgres
# Wait for postgres healthcheck (pg_isready -U edusupervise_owner)
# The entrypoint re-runs all three init scripts on first boot of the empty dir.
```

Then skip ahead to step 7 (restart the stack) — no separate restore
needed unless you have a specific dump file to load.

> If the script fails with `EDUSUPERVISE_RUNTIME_PASSWORD: unbound
> variable`, the postgres service isn't loading
> `/root/edusupervise-secrets/.env`. Check `env_file:` in
> `docker/docker-compose.yml` and re-run `deploy/install.sh` to
> regenerate the file.

### 5. Restore the dump

```bash
DUMP=/data/backups/edusupervise-2026-06-28.dump
cat "${DUMP}" | \
  docker compose -f docker/docker-compose.yml exec -T postgres \
  pg_restore -U edusupervise_owner -d edusupervise --no-owner --no-acl
```

`--no-owner --no-acl` because the dump was taken with the owner role
and we don't want `pg_restore` to try to reassign ownership (the
runtime + system roles can't own tables).

`pg_restore` may print `WARNING: errors ignored on restore: N` — these
are usually harmless (e.g. trying to drop an index that doesn't exist
in a fresh DB). The data is restored.

### 6. Re-run drizzle-kit migrations

The dump captures the schema at the time of backup. Any migrations
generated *after* that dump need to be applied on top:

```bash
docker compose -f docker/docker-compose.yml run --rm \
  -e "DATABASE_URL=postgres://edusupervise_owner:$(cat /root/edusupervise-secrets/postgres_password.txt)@postgres:5432/edusupervise" \
  web pnpm --filter @edusupervise/db migrate
```

Drizzle-kit is idempotent — if the migration was already applied, it
skips it. The `-e DATABASE_URL=...` override points at the owner role
(runtime role can't `CREATE TABLE`).

### 7. Restart the stack

```bash
docker compose -f docker/docker-compose.yml up -d
```

### 8. Smoke-test

1. Open `https://edusupervise.ashbi.ca/login`.
2. Log in with an admin account that existed in the backup.
3. Visit `/app/settings/audit` — recent `audit_log` rows should be
   visible. If they aren't, the role recreate step missed a grant
   (see Failure modes below).
4. Trigger a manual reminder send via `/app/reminders` → "Send now"
   and check that `reminder_log` gets a new row.
5. Run the cron container once and verify it doesn't error:
   ```bash
   docker compose -f docker/docker-compose.yml exec cron \
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /sql/audit-retention.sql
   ```

If all of the above pass, the restore is good. Move on to the
`docs/runbooks/incident-debug.md` flow if anything looks off.

## Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pg_restore: error: could not execute query: ERROR: role "edusupervise_runtime" does not exist` | Skipped step 4 | Re-run step 4. |
| Web container logs `permission denied for table users` | Role grants not applied | Re-run `db/init/02-schema.sql` (which contains the GRANT statements at the end). |
| Login fails with "school not found" after restore | Roles recreated but `app.school_id` not set on session | Application bug; check `withSchoolContext` wraps the query (search for it in `packages/db/src/rls.ts`). |
| Reminders not firing after restore | `outbox` table empty (intentional — outbox is transient) | Workers re-create entries as reminders are scheduled. Wait 5 min for the next outbox-flush cycle, or trigger a manual reminder send to populate. |
| `deploy/backup.sh` reports "no space left on device" mid-dump | `/data/backups` filled up | Free space (delete old dumps manually or shrink retention) and re-run. The script's atomic move (`mv -f`) means a failed dump never leaves a partial file. |
| `01-roles.sql` fails with `variable "runtimedb_password" not set` | Postgres service missing `env_file:` in `docker/docker-compose.yml` | Re-add `env_file:` (default `/root/edusupervise-secrets/.env`) to the postgres service and restart the stack. |
| `pg_restore: error: could not open input file: bad dump file` | Dump file is truncated or `xz`/`zstd` compressed | Re-fetch from offsite backup target; verify with `pg_restore -l file.dump \| head`. |
| Restored DB has data from yesterday, not the day you wanted | Picked the wrong dump | `ls -lh /data/backups/edusupervise-*.dump` — pick the one with the date you want. |

## Test restore on a clean Postgres (RPO verification)

You should run this at least once per quarter to verify backups are
actually restorable. The stop condition for `devops-deploy` is a
local dry-run of this exact flow.

```bash
# 1. Spin up a throwaway Postgres in Docker.
docker run -d --name edusupervise-restore-test \
  -e POSTGRES_USER=edusupervise_owner \
  -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=edusupervise \
  -e EDUSUPERVISE_RUNTIME_PASSWORD=testpw \
  -e EDUSUPERVISE_SYSTEM_PASSWORD=testpw \
  -v /Users/you/edusupervise/db/init:/docker-entrypoint-initdb.d:ro \
  postgres:16-alpine

# 2. Wait for the entrypoint to finish running 01-roles.sql + 02-schema.sql + 03-seed.sql.
docker logs -f edusupervise-restore-test
# Stop tailing once you see "database system is ready to accept connections"
# and the init scripts have completed.

# 3. Verify roles + schema exist.
docker exec edusupervise-restore-test psql -U edusupervise_owner -d edusupervise \
  -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'edusupervise_%';"
docker exec edusupervise-restore-test psql -U edusupervise_owner -d edusupervise \
  -c "\dt"

# 4. Restore the most recent dump.
DUMP=$(ls -t /data/backups/edusupervise-*.dump | head -n1)
cat "${DUMP}" | docker exec -i edusupervise-restore-test \
  pg_restore -U edusupervise_owner -d edusupervise --no-owner --no-acl

# 5. Verify.
docker exec edusupervise-restore-test psql -U edusupervise_owner -d edusupervise \
  -c "SELECT count(*) FROM schools;"
docker exec edusupervise-restore-test psql -U edusupervise_owner -d edusupervise \
  -c "SELECT count(*) FROM users;"
docker exec edusupervise-restore-test psql -U edusupervise_owner -d edusupervise \
  -c "SELECT count(*) FROM audit_log;"

# 6. Clean up.
docker rm -f edusupervise-restore-test
```

Expected: school + user counts match the day before the dump;
`audit_log` count is non-zero. If school count is zero, the dump is
truncated or was taken on an empty DB. If `audit_log` is zero but
schools are non-zero, the dump predates the first action (e.g.
signup never fired an audit row because of an early code bug).

## Recovery point / time targets

- **RPO (Recovery Point Objective):** 24 hours. Backups run daily at
  03:00 UTC. Worst case: lose up to 24h of writes if the DB dies
  between backups.
- **RTO (Recovery Time Objective):** ~15 minutes for the restore
  itself (steps 1–7), plus however long step 8's smoke test takes
  (~5 min for a non-trivial school). Total: ~20 min for a single
  school; longer if the dump is large (>2 GB). The "wipe postgres data
  dir and let init scripts re-run" shortcut in step 4 takes ~2 min
  on a small DB but loses everything since the last dump + anything
  in `/data/uploads`.