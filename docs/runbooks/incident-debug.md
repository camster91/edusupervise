# Incident debug runbook

Quick-reference for the three most common production issues. Each
section has a symptom, a diagnostic SQL/command one-liner, and a fix.
If none of these match, check `deploy/healthcheck.sh` and the
`docker logs` output for the affected service.

> **Smoke test** (use after any fix to confirm the issue is resolved):
>
> ```bash
> # 1. Health
> curl -fsS https://edusupervise.ashbi.ca/api/health | jq .
> # 2. Login
> curl -fsS -c /tmp/cookies.txt -b /tmp/cookies.txt \
>   -X POST https://edusupervise.ashbi.ca/api/auth/sign-in \
>   -H 'Content-Type: application/json' \
>   -d '{"email":"admin@maple.test","password":"password123"}'
> # 3. List duties
> curl -fsS -b /tmp/cookies.txt https://edusupervise.ashbi.ca/api/duties | jq length
> ```

---

## 1. "Reminders not firing"

User reports that a teacher didn't get an email/SMS reminder for a
duty that was scheduled to fire minutes/hours ago.

### Diagnostic flow

```bash
# 1. Is the worker alive?
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT worker_id, last_beat, jobs_completed, EXTRACT(EPOCH FROM (now() - last_beat)) AS age_s FROM worker_heartbeats;"

# 2. Is the outbox flusher running? (rows in `outbox` with enqueued_at IS NULL
#    older than 30s indicate a stuck flusher.)
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT count(*) AS pending, EXTRACT(EPOCH FROM (now() - min(created_at))) AS oldest_age_s FROM outbox WHERE enqueued_at IS NULL;"

# 3. Are BullMQ jobs stalled? (connect to redis and look for stalled jobs)
sudo docker compose -f docker/docker-compose.yml exec redis \
  sh -c "redis-cli ZRANGE bull:reminders:stalled 0 -1 WITHSCORES | head"
# A healthy worker drains stalled jobs within 30s.

# 4. Look at the most recent reminder_log rows.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT reminder_id, channel, status, error, attempts, created_at, sent_at FROM reminder_log ORDER BY created_at DESC LIMIT 20;"

# 5. Worker logs (last 200 lines).
sudo docker logs edusupervise-worker-1 --tail 200 --since 1h
```

### Most likely causes (in order)

#### A. Worker is dead or stuck

**Symptom:** `worker_heartbeats.last_beat` is >90s old, or
`/api/health.workers` is empty / ages >90s.

**Fix:**

```bash
# Restart the worker.
sudo docker compose -f docker/docker-compose.yml restart worker
# If the worker OOMs (check `docker stats edusupervise-worker-1` for
# memory >mem_limit), bump mem_limit in docker/docker-compose.yml.
```

#### B. Outbox flusher is stuck

**Symptom:** `pending` count >10 and `oldest_age_s` >60. The flusher
job (`apps/worker/src/jobs/outbox-flush.ts`) is supposed to run every
5s and enqueue pending outbox rows to BullMQ.

**Diagnose:**

```bash
sudo docker logs edusupervise-worker-1 --tail 500 --since 10m | grep -E 'outbox|flush'
```

**Fix:**

```bash
# Restart the worker to re-register the flusher job.
sudo docker compose -f docker/docker-compose.yml restart worker
# If it recurs, check the outbox table for a row that errors on enqueue
# (e.g. payload too large). Look for the worker's outbox job in
# `docker logs` and find the offending payload.
```

#### C. BullMQ stalled jobs

**Symptom:** jobs are in the queue but not processing. `pending` in
outbox is low, but `reminder_log` has no recent rows.

**Diagnose:**

```bash
sudo docker compose -f docker/docker-compose.yml exec redis \
  sh -c "redis-cli ZRANGE bull:reminders:stalled 0 -1"
sudo docker compose -f docker/docker-compose.yml exec redis \
  sh -c "redis-cli ZRANGE bull:reminders:failed 0 -1"
```

**Fix:**

```bash
# Drain stalled jobs — BullMQ should do this automatically when the
# worker is healthy, but if it's stuck:
sudo docker compose -f docker/docker-compose.yml exec redis \
  sh -c "redis-cli DEL bull:reminders:stalled"
sudo docker compose -f docker/docker-compose.yml restart worker
```

#### D. Reminder payload validation fails

**Symptom:** `reminder_log.status = 'failed'` with
`error: 'invalid_payload'`. The reminder is created but the worker's
Zod validator rejects it (e.g. `schoolId` missing).

**Diagnose:**

```bash
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT id, payload, error FROM outbox WHERE created_at > now() - interval '1 hour' AND enqueued_at IS NOT NULL ORDER BY created_at DESC LIMIT 5;"
```

**Fix:** root cause is in the producer (the web server) — it's
creating a malformed payload. This is a code bug, not an ops issue.
Open a ticket; do not patch the worker to "fix" the payload.

#### E. Provider key invalid / quota hit

**Symptom:** `reminder_log.status = 'failed'` with HTTP 401/429 from
Resend/Twilio.

**Diagnose:**

```bash
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT error, count(*) FROM reminder_log WHERE status = 'failed' AND created_at > now() - interval '1 hour' GROUP BY error;"
```

**Fix:** see `docs/runbooks/rotate-secrets.md` for rotating the key;
also check the provider's dashboard for quota/usage anomalies.

---

## 2. "RLS leak suspected"

A user reports they can see another school's data (e.g. a teacher
sees duties that aren't from their school), or a security audit
raises the question.

> **Defense in depth reminder:** the runtime role does NOT own
> tables; that's the whole point of `FORCE ROW LEVEL SECURITY`. The
> web app MUST connect as the runtime role for FORCE to be effective.
> If the app connects as the owner role, RLS is silently bypassed.

### Diagnostic flow

```bash
# 1. Confirm FORCE ROW LEVEL SECURITY is set on every tenant table.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise <<'SQL'
SELECT c.relname,
       c.relrowsecurity     AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
SQL

# 2. Verify policies exist and use the right predicate.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;"

# 3. Confirm the app is connecting as the runtime role (NOT owner).
sudo docker compose -f docker/docker-compose.yml exec web env | grep DATABASE_URL
# Expected: postgres://edusupervise_runtime:...@postgres:5432/edusupervise
# If it shows edusupervise_owner, that's the bug — the web container
# is connecting as the owner role, which BYPASSES RLS.

# 4. Test the RLS boundary directly.
#    (From the runtime role, set school_id to A, query, then to B.)
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_runtime -d edusupervise <<'SQL'
SET app.school_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) AS visible_to_school_A FROM duties;
SET app.school_id = '22222222-2222-2222-2222-222222222222';
SELECT count(*) AS visible_to_school_B FROM duties;
RESET app.school_id;
SQL
# If school_A and school_B both return total_duties, RLS is broken.

# 5. Look for recent audit log entries from the same user that
#    touch rows in multiple schools (the tell-tale sign of a leak).
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT user_id, count(distinct school_id) AS schools_touched FROM audit_log WHERE created_at > now() - interval '24 hours' GROUP BY user_id HAVING count(distinct school_id) > 1;"
# A user touching >1 school is a leak signal.
```

### Most likely causes (in order)

#### A. App is connecting as the owner role

**Symptom:** step 3 above shows `edusupervise_owner` in
`DATABASE_URL` on the web container.

**Fix:**

```bash
# Edit docker/docker-compose.yml — the `web` service's DATABASE_URL
# should be `edusupervise_runtime:...`. The `worker` and `cron`
# services use `edusupervise_system` (which has BYPASSRLS, OK for
# system jobs).
#
# If the env_file has EDUSUPERVISE_RUNTIME_PASSWORD set correctly,
# the URL is built via interpolation. Verify both:
sudo cat /root/edusupervise-secrets/.env | grep -E '^(EDUSUPERVISE_(RUNTIME|SYSTEM)|POSTGRES)_PASSWORD'
# Then restart:
sudo docker compose -f docker/docker-compose.yml restart web
```

#### B. `withSchoolContext` is missing on a query path

**Symptom:** a specific endpoint returns rows from all schools, but
the runtime role is being used.

**Fix:** search the codebase for raw `db.select(...)` calls that
don't go through `withSchoolContext`:

```bash
cd /opt/edusupervise
grep -rn 'db.select\|db.insert\|db.update\|db.delete' \
  apps/web/server apps/web/app/routes \
  | grep -v 'withSchoolContext\|tx.'
```

Any line that touches a table without `withSchoolContext` (or that
isn't inside a `tx.execute(sql\`SET LOCAL app.school_id = ...\`)`)
is a leak. Fix by wrapping in `withSchoolContext`.

#### C. `FORCE` not set

**Symptom:** step 1 above shows `rls_forced = f` on some tables.

**Fix:**

```sql
ALTER TABLE <table_name> FORCE ROW LEVEL SECURITY;
```

This is set in `db/init/02-schema.sql` via the DO block. If a
table was added by a later migration without the FORCE, this is a
migration bug. Add `ALTER TABLE <new_table> FORCE ROW LEVEL SECURITY;`
to the migration.

#### D. `current_school_id()` is returning NULL

**Symptom:** with `app.school_id` not set, the policy
`school_id = current_school_id()` evaluates to `NULL = <uuid>` which
is NULL → no rows visible. But if the app code sets it to a
**different** school's id (e.g. by accident), data leaks.

**Diagnose:**

```bash
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT pid, application_name, query FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%app.school_id%';"
# Inspect any active query and confirm the SET LOCAL value matches the
# session's authenticated school.
```

**Fix:** audit `apps/web/server/db.server.ts`'s
`withSchoolContext` to confirm `schoolId` comes from the session
and is not settable from query params or request body.

---

## 3. "Stripe webhook not processed"

User reports a billing change (upgrade, downgrade, payment) didn't
take effect, or the Stripe dashboard shows a webhook with
`response: 4xx/5xx`.

### Diagnostic flow

```bash
# 1. Was the event received?
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT id, type, processed_at FROM stripe_events WHERE id = 'evt_XXXXX' ORDER BY processed_at DESC LIMIT 5;"
# Replace evt_XXXXX with the actual event id from the Stripe dashboard.

# 2. Is the webhook endpoint reachable from the public internet?
curl -i https://edusupervise.ashbi.ca/api/billing/webhook
# Expected: 400 (signature missing) or 200 if you have a valid test
# event. NEVER 404, 502, 503.

# 3. Check the web container's recent logs for the webhook handler.
sudo docker logs edusupervise-web-1 --tail 200 --since 1h | grep -E 'webhook|stripe'

# 4. Look at audit_log for billing-related actions.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT created_at, user_id, action, target_id, metadata FROM audit_log WHERE action LIKE 'billing.%' ORDER BY created_at DESC LIMIT 20;"

# 5. Confirm the signature secret matches Stripe's expectation.
sudo docker compose -f docker/docker-compose.yml exec web \
  sh -c "printenv STRIPE_WEBHOOK_SECRET | head -c 12; echo"
# Compare the first 12 chars to the Stripe dashboard's webhook
# endpoint details.
```

### Most likely causes (in order)

#### A. Webhook signature verification failed

**Symptom:** web logs show `Stripe signature verification failed` or
`InvalidSignatureError`. The event is in Stripe's dashboard with
`response: 400`.

**Fix:**

```bash
# 1. Confirm STRIPE_WEBHOOK_SECRET matches the Stripe dashboard.
#    See docs/runbooks/rotate-secrets.md for the rotation procedure.
# 2. If the secret was just rolled, make sure both the old and new
#    secrets don't conflict — Stripe sends the new one immediately
#    after rolling.
# 3. Restart the web container to pick up the new env.
sudo docker compose -f docker/docker-compose.yml restart web
```

#### B. The event is a duplicate (already in `stripe_events`)

**Symptom:** the event id is in `stripe_events` with a recent
`processed_at`. The handler returned 200 (idempotency working as
designed), but the side effect (e.g. plan upgrade) didn't apply.

**Diagnose:** the `stripe_events` row was inserted (dedup hit) but
the transaction's state change rolled back. This is by design — the
dedup row is inserted BEFORE the state change so a failed change
rolls back the dedup.

**Fix:** look at the web logs for the actual error during the
handler:

```bash
sudo docker logs edusupervise-web-1 --tail 500 --since 1h | grep -B2 -A10 "$(event_id)"
```

Common causes:
- Plan limit check failed (e.g. trying to upgrade a school to Pro
  when their stripe_customer_id is already bound to another school).
- Foreign-key violation (referenced `school_id` was deleted).
- RLS issue (worker tried to write under a different `school_id`).

#### C. Webhook URL changed or is misconfigured

**Symptom:** Stripe dashboard shows `404 Not Found` or `Connection
refused`.

**Fix:**

```bash
# 1. In the Stripe dashboard, confirm the endpoint URL is exactly:
#    https://edusupervise.ashbi.ca/api/billing/webhook
# 2. Test from a curl one-liner:
curl -i -X POST https://edusupervise.ashbi.ca/api/billing/webhook \
  -H 'Stripe-Signature: t=0,v1=fake' -d '{}'
# Expected: 400 (signature verification failed). If 404, the route
# isn't registered — check apps/web/app/routes/api.billing.webhook.tsx.
```

#### D. Traefik rate-limited or returned a 5xx

**Symptom:** Stripe shows `response: 502/503/504`. This means the
web container is up but Traefik can't reach it, or the app crashed.

**Fix:**

```bash
# 1. Confirm the app is healthy.
curl -fsS https://edusupervise.ashbi.ca/api/health
# 2. Check web container's last 200 log lines.
sudo docker logs edusupervise-web-1 --tail 200
# 3. Restart the web container.
sudo docker compose -f docker/docker-compose.yml restart web
```

#### E. Network / firewall block

**Symptom:** Stripe shows `Connection timed out` for hours.

**Fix:** check VPS firewall:

```bash
sudo ufw status verbose
# 80/tcp and 443/tcp should be ALLOW. If not:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

---

## Quick reference: all SQL one-liners

```bash
# Open an interactive psql as the owner.
PSQL="sudo docker compose -f docker/docker-compose.yml exec postgres psql -U edusupervise_owner -d edusupervise"
$PSQL

# Recent audit log.
$PSQL -c "SELECT created_at, school_id, user_id, action, target_id FROM audit_log ORDER BY created_at DESC LIMIT 20;"

# Active workers and their heartbeat age.
$PSQL -c "SELECT worker_id, EXTRACT(EPOCH FROM (now() - last_beat)) AS age_s, jobs_completed FROM worker_heartbeats ORDER BY worker_id;"

# Outbox backlog.
$PSQL -c "SELECT count(*) AS pending, EXTRACT(EPOCH FROM (now() - min(created_at))) AS oldest_s FROM outbox WHERE enqueued_at IS NULL;"

# Recent failed reminders.
$PSQL -c "SELECT created_at, channel, status, error, attempts FROM reminder_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;"

# RLS posture.
$PSQL -c "SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r' ORDER BY relname;"

# Stripe events in the last 24h.
$PSQL -c "SELECT type, count(*) FROM stripe_events WHERE processed_at > now() - interval '24 hours' GROUP BY type ORDER BY count DESC;"
```
