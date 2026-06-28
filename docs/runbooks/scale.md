# Scale runbook

When the stack needs more capacity, you have two options:

1. **Vertical scale** — move to a larger VPS (e.g. from 4 vCPU/8 GB to
   8 vCPU/16 GB). Cheaper, simpler, takes ~30 min of downtime.
2. **Horizontal scale** — add a second worker container. Targets the
   specific bottleneck (reminder dispatch throughput). No downtime.

This runbook covers both, plus the Postgres tuning that goes with each
size. Read the "When to scale" section first.

## When to scale

Don't scale based on a single high-CPU moment. Look for sustained
patterns:

| Signal | Symptom | Likely fix |
|--------|---------|------------|
| `deploy/healthcheck.sh` returns 1 (degraded) regularly | Worker heartbeats stale | Add a second worker (horizontal). |
| Reminder delivery lag >5 min from scheduled time | Outbox backlog growing | Add a second worker AND increase Postgres shared_buffers. |
| `docker stats edusupervise-postgres-1` shows CPU pinned at 100% for >5 min | Postgres under-provisioned | Move to a 16 GB host + tune Postgres. |
| `docker stats edusupervise-web-1` shows memory >1.2 GB | Web app needs more headroom | Bump web `mem_limit` to 2 GB. Vertical scale. |
| Login latency >500ms (P95) | DB connection saturation or session lookup slow | Increase `max_connections` (with care) or add a Redis cache for session lookups. |

## Option 1: Add a second worker

This is the most common scale move. The bottleneck for a school-day
is reminder dispatch — adding a second worker doubles that throughput
without touching the DB.

The second worker uses the same image, same env, but a different
`worker_id` (so heartbeats don't collide on the PK).

### Step 1: edit `docker/docker-compose.yml`

Add a `worker-2` service. The exact addition (paste below the existing
`worker:` block):

```yaml
  worker-2:
    build:
      context: ..
      dockerfile: docker/Dockerfile.worker
    restart: unless-stopped
    container_name: edusupervise-worker-2
    env_file: /root/edusupervise-secrets/.env
    environment:
      DATABASE_URL: postgres://edusupervise_system:${EDUSUPERVISE_SYSTEM_PASSWORD}@postgres:5432/edusupervise
      REDIS_URL: redis://redis:6379
      NODE_ENV: production
      LOG_LEVEL: ${LOG_LEVEL:-info}
      EMAIL_PROVIDER: ${EMAIL_PROVIDER:-mock}
      SMS_PROVIDER: ${SMS_PROVIDER:-mock}
      # Unique worker id for heartbeats and log correlation.
      WORKER_ID: edusupervise-worker-2
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    mem_limit: 1g
    cpus: "1.0"
```

### Step 2: make sure the worker reads `WORKER_ID`

The `worker_heartbeats` table has `worker_id TEXT PRIMARY KEY`, so each
worker needs a stable unique id. The default in the worker code is
likely `os.hostname()` (the container's hostname, which docker compose
makes unique per replica). If you want a deterministic value, set
`WORKER_ID` in the environment as above.

If the worker code doesn't already read `WORKER_ID`, edit
`apps/worker/src/heartbeat.ts` to use it:

```ts
const workerId = process.env.WORKER_ID ?? os.hostname();
```

### Step 3: bring up the new worker

```bash
cd /opt/edusupervise
sudo docker compose -f docker/docker-compose.yml up -d worker-2
```

### Step 4: verify

```bash
# Both workers should heartbeat within 30s of start.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT worker_id, last_beat, jobs_completed FROM worker_heartbeats ORDER BY worker_id;"

# Healthcheck should now show 2 workers.
curl -fsS https://edusupervise.ashbi.ca/api/health | jq .workers
```

### Step 5 (optional): scale further

You can repeat the pattern for `worker-3`, `worker-4`, etc. Up to
~5-6 workers before you start hitting Postgres connection limits. If
you need more, you also need to bump `max_connections` (see Option 2).

## Option 2: Move to a larger VPS

Use this when the host is consistently out of memory, disk is filling
up, or you've hit the 5-6 worker ceiling.

Target: 8 vCPU / 16 GB RAM / 200 GB NVMe. This is the recommended size
for "20+ schools" per spec section 13.

### Step 1: snapshot the existing data

```bash
# Full DB backup before any destructive change.
sudo /opt/edusupervise/deploy/backup.sh

# Snapshot the /data directory (postgres data + uploaded files).
sudo rsync -a /data/ /data-backup-$(date +%F)/
```

### Step 2: provision the new VPS

Create the new VPS with the same SSH keys + sudo user. Install:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin openssl rsync curl
sudo usermod -aG docker <deploy-user>
```

### Step 3: copy secrets and data

```bash
# 1. Copy the secrets directory.
sudo rsync -a /root/edusupervise-secrets/ <deploy-user>@new-vps:/root/edusupervise-secrets/

# 2. Stop the old stack.
cd /opt/edusupervise
sudo docker compose -f docker/docker-compose.yml down

# 3. Sync /data to the new host.
sudo rsync -a /data/ <deploy-user>@new-vps:/data/

# 4. Sync the repo (or re-clone it).
sudo rsync -a --exclude node_modules --exclude .git --exclude build \
  /opt/edusupervise/ <deploy-user>@new-vps:/opt/edusupervise/

# 5. Drop the Traefik dynamic config on the new host's Traefik (if
#    you're not using a shared Traefik).
```

### Step 4: cut DNS over

Lower the TTL on the DNS A record for `edusupervise.ashbi.ca` at least
1 hour before the cutover (e.g. 300s). At cutover time, point the
record at the new VPS's IP. Existing sessions remain valid (the secret
didn't change).

### Step 5: bring up the new stack

```bash
ssh <deploy-user>@new-vps
cd /opt/edusupervise
sudo /opt/edusupervise/deploy/install.sh --skip-migrate
# (The data is already in /data/postgres, so the init scripts
#  won't run; if /data/postgres is empty (e.g. you're restoring
#  from backup), the install script will do first-boot setup.)
```

### Step 6: tune Postgres for 16 GB (see below)

```bash
sudo cp /opt/edusupervise/deploy/postgres/postgresql-16gb.conf \
  /data/postgres/postgresql.conf
sudo docker compose -f docker/docker-compose.yml restart postgres
```

### Step 7: verify

```bash
curl -fsS https://edusupervise.ashbi.ca/api/health | jq .
# Login as a known user, check audit log, send a test reminder.
```

## Postgres tuning

`postgresql.conf` lives in `/data/postgres/postgresql.conf` (mounted
into the container as `/var/lib/postgresql/data/postgresql.conf`).
After editing, restart the postgres container for changes to take
effect.

### 8 GB host (Tier 1 minimum)

The spec defaults. Use as-is for the first 1-3 schools.

```ini
# /data/postgres/postgresql.conf
shared_buffers = 1GB
work_mem = 16MB
maintenance_work_mem = 256MB
effective_cache_size = 3GB
max_connections = 100
random_page_cost = 1.1             # SSD
effective_io_concurrency = 200     # NVMe
wal_buffers = 16MB
min_wal_size = 512MB
max_wal_size = 2GB
checkpoint_completion_target = 0.9
default_statistics_target = 100
log_min_duration_statement = 500   # log slow queries (>500ms)
```

### 16 GB host (Tier 1 recommended, 20+ schools)

This is what to apply when moving to a larger VPS or hitting
performance ceilings on the 8 GB host.

```ini
# /data/postgres/postgresql.conf  (16GB host)
shared_buffers = 4GB               # 25% of RAM
work_mem = 32MB                    # doubled; dangerous if max_connections high
maintenance_work_mem = 1GB         # speeds up index builds
effective_cache_size = 12GB        # 75% of RAM (kernel cache estimate)
max_connections = 200              # 2x for more concurrent workers
random_page_cost = 1.1             # SSD
effective_io_concurrency = 200     # NVMe
wal_buffers = 16MB
min_wal_size = 1GB
max_wal_size = 4GB
checkpoint_completion_target = 0.9
default_statistics_target = 200    # better query plans at cost of stats time
log_min_duration_statement = 250   # log >250ms queries
log_lock_waits = on
log_temp_files = 0
```

Notes:
- `work_mem = 32MB` is per-operation, not per-query. With
  `max_connections = 200` and a few heavy sorts running in parallel,
  peak memory could spike. Watch `docker stats edusupervise-postgres-1`
  for a day after the change; lower to 16MB if you see OOMs.
- `maintenance_work_mem = 1GB` makes `CREATE INDEX` and `VACUUM` much
  faster but uses 1 GB at peak. If you have a busy time, schedule
  index builds for off-hours.
- `effective_cache_size` is a HINT to the planner, not a hard limit.
  It tells Postgres "this much RAM is available for caching." Setting
  it too low makes the planner avoid indexes; too high makes it over-
  estimate. 12GB on a 16GB host is safe.

### 32 GB host (Tier 2 — not yet needed)

If you outgrow the 16 GB host, scale to 32 GB before adding more
worker containers. The relevant changes:

```ini
shared_buffers = 8GB
work_mem = 64MB
maintenance_work_mem = 2GB
effective_cache_size = 24GB
max_connections = 300
```

## Verifying the scale-up

After any scale change, run the smoke test in
`docs/runbooks/incident-debug.md#smoke-test`. Specifically:

```bash
# 1. Healthcheck.
curl -fsS https://edusupervise.ashbi.ca/api/health | jq .

# 2. Concurrent load (synthetic). Fire 50 reminder sends in parallel
#    and confirm all complete within 60s.
#    (This is automated in tests/integration/worker.test.ts — run that
#    against a clone of prod for a real-world load test.)

# 3. Check the postgres slow log.
sudo docker exec edusupervise-postgres-1 \
  tail -n 200 /var/lib/postgresql/data/log/postgresql-*.log \
  | grep -E 'duration:|lock wait'

# 4. Confirm heartbeat freshness.
sudo docker compose -f docker/docker-compose.yml exec postgres \
  psql -U edusupervise_owner -d edusupervise \
  -c "SELECT worker_id, EXTRACT(EPOCH FROM (now() - last_beat)) AS age_s FROM worker_heartbeats;"
```

If `age_s` is ever >90s, the worker is unhealthy — see
`docs/runbooks/incident-debug.md`.
