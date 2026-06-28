# EduSupervise restore runbook

When the database is corrupt or you need to roll back, restore from a pg_dump file
in `/data/backups/`. This runbook assumes you have:

- A backup file like `/data/backups/edusupervise-2026-06-28.dump` (custom format)
- The secrets file at `/root/edusupervise-secrets/.env`
- SSH access to vps.ashbi.ca as a user with sudo + docker access

## Why this isn't a one-liner

`pg_dump` does not dump roles. The `edusupervise_runtime` and `edusupervise_system`
roles are created by `db/init/00-create-roles.sh` on first container boot. After a
`DROP DATABASE` or full rebuild, you must recreate the roles BEFORE restoring data.

## Steps

1. **Stop the app and worker** so nothing writes during restore.

   ```bash
   cd /opt/edusupervise  # or wherever the repo is checked out
   docker compose -f docker/docker-compose.yml stop web worker cron
   ```

2. **Drop and recreate the database.** This wipes everything except roles
   (which are cluster-wide in Postgres).

   ```bash
   docker compose -f docker/docker-compose.yml exec postgres \
     psql -U edusupervise_owner -c "DROP DATABASE edusupervise;"
   docker compose -f docker/docker-compose.yml exec postgres \
     psql -U edusupervise_owner -c "CREATE DATABASE edusupervise OWNER edusupervise_owner;"
   ```

3. **Recreate the runtime + system roles** (they live in the cluster, not the DB).

   ```bash
   docker compose -f docker/docker-compose.yml exec postgres \
     bash /docker-entrypoint-initdb.d/00-create-roles.sh
   ```

4. **Restore the dump** as the owner role.

   ```bash
   cat /data/backups/edusupervise-2026-06-28.dump | \
     docker compose -f docker/docker-compose.yml exec -T postgres \
     pg_restore -U edusupervise_owner -d edusupervise --no-owner --no-acl
   ```

   `--no-owner --no-acl` because the dump was taken with the owner role; we don't
   want pg_restore to try to reassign ownership (the runtime role can't own).

5. **Re-run the schema init** to make sure any newer columns / indexes from
   drizzle-kit migrations are applied on top of the restored schema.

   ```bash
   docker compose -f docker/docker-compose.yml run --rm web \
     pnpm --filter @edusupervise/db migrate
   ```

6. **Restart the stack.**

   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

7. **Smoke-test** by logging in at https://edusupervise.ashbi.ca/login with
   the admin credentials that existed in the backup. Then visit
   `/app/settings/audit` and confirm recent audit log rows are visible.

## Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pg_restore: error: could not execute query: ERROR: role "edusupervise_runtime" does not exist` | Skipped step 3 | Re-run step 3 |
| Web container logs "permission denied for table users" | Role grants not applied | Re-run step 3 — the GRANT statements are inside the .sh script |
| Login fails with "school not found" after restore | Roles recreated but `app.school_id` not set on session | Application bug; check `withSchoolContext` is wrapping the query |
| Reminders not firing after restore | outbox table empty (intentional — outbox is transient) | Workers will re-create entries as reminders are scheduled |
