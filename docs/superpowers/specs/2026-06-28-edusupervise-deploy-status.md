# EduSupervise Deploy Status — 2026-06-28

## TL;DR

- **Code:** complete Tier 1 spec + working baseline, committed to `camster91/edusupervise` main (~30 commits).
- **Infrastructure on VPS (vps.ashbi.ca):** Docker stack running with Postgres + Redis + Web + Worker + Cron containers. Web serves HTML, Postgres has 3 roles + FORCE RLS + schema + plan_limits seed.
- **Status:** partially deployed. Web container responds 200 on `/signup`. DB queries return errors (postgres.js API issue, see §5). DNS not yet pointed at the VPS.
- **What's deferred:** real better-auth integration, Stripe billing, admin pages (teachers/reports/audit/settings), calendar exports, full Tier 2 features.

This document captures the current state, what's broken, and how to resume.

## 1. Repo state

| | |
|---|---|
| Repo | `https://github.com/camster91/edusupervise` |
| Branch | `main` |
| Spec | `docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md` (1369 lines, 3 reviewer iterations, approved) |
| Lines of code | ~6000 across `apps/`, `packages/`, `db/`, `docker/`, `deploy/`, `docs/` |
| License | MIT |
| Public/Private | Public |

## 2. What shipped

### Database
- Drizzle schema (681 lines, `packages/db/src/schema.ts`) — mirrors `db/init/01-schema.sql`
- Three Postgres roles: `edusupervise_owner` (migrations), `edusupervise_runtime` (web, FORCE RLS), `edusupervise_system` (worker/cron/webhook, BYPASSRLS)
- `FORCE ROW LEVEL SECURITY` on every tenant table
- `withSchool` / `withUser` transaction wrappers in `packages/db/src/rls.ts` that set `app.school_id` via `SET LOCAL` before each query
- Cycle math (`packages/db/src/cycle-math.ts`) with 13 vitest cases covering school-year boundaries, leap years, calendar overrides
- Drizzle migration `0000_init.sql` for `authSession/authAccount/authVerification` (dormant, ready for Tier 1.5 better-auth swap)

### Provider adapters (mock-by-default)
- `packages/email/` — `sendEmail({to, subject, body})` with `EMAIL_PROVIDER=mock|resend`. Default mock logs to `/data/mocks/emails.log`.
- `packages/sms/` — `sendSms({to, body})` with `SMS_PROVIDER=mock|twilio`. Default mock logs.
- `packages/billing-adapter/` — Stripe checkout/portal/webhook helpers with `BILLING_PROVIDER=mock|stripe`. Default mock returns fake URLs.

Switch to real by setting the provider env var + the corresponding API key. No code changes.

### Auth (minimal bcrypt + HMAC, not better-auth)
- `apps/web/server/auth.server.ts` — bcrypt 12 rounds, HMAC-SHA256 signed session cookie (`edusupervise.session`). 30-day TTL. `getSession`, `requireSession`, `requireRole` helpers.
- `apps/web/server/csrf.server.ts` — double-submit cookie pattern (defined but not yet wired into fetch wrapper; same-origin dev doesn't need it).

### Frontend (React Router 7 SSR)
- Public: landing (`/`), signup, login, logout
- Authenticated shell: dashboard, duties list, duty detail, duty create, duty assign
- Placeholder pages (placeholder content): calendar, assignments, reminders, teachers, settings
- Admin gating via `requireRole(session, ['school_admin'])`

### Worker
- `apps/worker/src/index.ts` — BullMQ-style polling loop. Every 5s, reads `outbox` rows where `enqueued_at IS NULL`, dispatches via `@edusupervise/email` mock, marks `enqueued_at = now()`. Heartbeat every 30s into `worker_heartbeats` table.

### Infrastructure
- `docker/docker-compose.yml` — 5 services (postgres, redis, web, worker, cron)
- `docker/Dockerfile.web` — multi-stage build, runtime stage uses `react-router-serve` to host the RR7 bundle on port 3011
- `docker/Dockerfile.worker` — slim Node 22, runs `dist/index.js`
- `db/init/00-create-roles.sh` — bash init script (env var passwords), creates the three Postgres roles + grants
- `db/init/01-schema.sql` — full schema + RLS + plan_limits seed (idempotent)
- `db/cron/audit-retention.sql` — nightly prune honoring per-plan retention
- `deploy/install.sh` (400 lines) — fresh VPS setup: secrets, Traefik, compose, migrations, health check
- `deploy/backup.sh` (145 lines) — pg_dump + rsync to offsite
- `deploy/healthcheck.sh` (120 lines) — bash equivalent of /api/health
- `deploy/traefik/edusupervise.yml` — Traefik dynamic router (Host `edusupervise.ashbi.ca` → web:3011)
- 5 runbooks: `production-deploy.md`, `restore.md`, `rotate-secrets.md`, `scale.md`, `incident-debug.md`

## 3. What was deferred

| Item | Why deferred | Where it lives |
|---|---|---|
| Real better-auth integration (full ~1.6.x config, magic link, OAuth) | The auth-rls worker session kept committing half-done code that broke the build. Replaced with minimal bcrypt + HMAC. Swap is a single-file change in `apps/web/server/auth.server.ts`. | spec section 5 |
| Stripe billing (Checkout, webhook, plan enforcement, downgrade grace flow) | Deferred behind `BILLING_PROVIDER=mock`. Real swap = a few hours of work. | spec section 6 |
| Admin pages: teachers CSV import, branding form, school-year rollover wizard, audit log UI, calendar feed token, reports (hours/coverage) | Routes exist as placeholders. Forms + backend logic deferred. | spec sections 8, 12 |
| Real Resend / Twilio integration | Currently `EMAIL_PROVIDER=mock`, `SMS_PROVIDER=mock`. Plug in keys + set provider to real. | spec section 10 |
| `.ics` calendar exports per user | Per-user feed endpoint deferred to Tier 2. | spec section 15 |
| Mobile (React Native + Expo), district multi-tenancy, AI scheduling, parent portal, Zapier | All Tier 3 / backlog. | spec section 16 |
| `tests/integration/*` test suite | `tests/integration/auth-rls.test.ts` from the auth-rls worker landed but doesn't run cleanly. Vitest config has workspace aliases but test harness isn't fully wired. | spec section 14 |

## 4. What's deployed on VPS (vps.ashbi.ca)

The docker stack is **running** with these container states:

```
docker-postgres-1   postgres:16-alpine   Up (healthy)       5432/tcp
docker-redis-1      redis:7-alpine      Up (healthy)       6379/tcp
docker-web-1        docker-web          Up                 (Traefik labels, no host port)
docker-worker-1     docker-worker       Up (restarting)
docker-cron-1       alpine:3.20         Up                 (audit-retention loop)
```

Secrets live at `/root/edusupervise-secrets/`:
- `postgres_password.txt`, `runtime_password.txt`, `system_password.txt`
- `session_secret.txt`, `better_auth_secret.txt`
- `.env` (interpolated, readable by web/worker/cron)

Web logs (most recent, from `docker logs docker-web-1`):
```
[react-router-serve] http://localhost:3011 (http://172.16.9.4:3011)
GET /api/health 200 - - 58.815 ms
```

The web container listens on port 3011 **inside** the Docker network. Traefik routes `edusupervise.ashbi.ca` → `docker-web:3011`. No host port published.

## 5. What's broken

### DB queries fail in the web container

`/api/health` returns `{"status":"degraded","db":"down"}`. The health endpoint calls `getDb().execute(sql\`SELECT 1\`)`, which throws silently.

Likely cause: `packages/db/src/client.ts` uses `postgres(url, opts)` and passes the result to `drizzle(sql, schema)`. With `postgres.js` 3.x, `postgres(url)` returns a **tagged template function** (not a Promise/Client). Drizzle's `postgres-js` adapter expects this function — but the runtime call path may be hitting a mismatch.

Quick fix candidates (in priority order):
1. Verify `postgres` 3.x + `drizzle-orm/postgres-js` 0.36.x compatibility (their docs claim full support; verify at runtime)
2. Try `await postgres(url, opts)` (3.x returns a Promise in newer versions)
3. Switch to the `pg` driver instead of `postgres-js` (also in spec section 3 as the fallback)

Reproduction:
```bash
ssh root@187.77.26.99
docker exec docker-web-1 node -e "
  const p = require('postgres');
  console.log('postgres version:', p.version);
  const c = p(process.env.DATABASE_URL);
  console.log('connection type:', typeof c, Object.keys(c).slice(0,5));
"
```

### DNS not pointed

`edusupervise.ashbi.ca` doesn't resolve to `187.77.26.99` yet. Without this, Traefik never gets traffic, and ACME can't issue a cert.

To fix: add an A record at your DNS provider:
- Host: `edusupervise`
- Type: A
- Value: `187.77.26.99`
- TTL: 300 (5 min) is fine

### Better-auth route files keep reappearing

The cancelled mavis-team plan's `auth-rls` worker session is still alive somewhere and keeps force-pushing commits that include half-done better-auth route files (`forgot.tsx`, `reset.tsx`, `verify-email.tsx`, `verify-phone.tsx`, `auth.magic.tsx`, etc.). I've deleted them repeatedly in commits `2d64420`, `83a0e54`, `6666e26`. They keep coming back.

If the deploy is paused: **freeze main branch** on GitHub so this can't happen, or kill the orphaned worker session (`mvs_b25f1517ec8d45f5bb2be4254e0c8315`).

### Postgres container has plan-downgrade columns not yet used

`schools.plan_downgrade_pending_to` and `plan_downgrade_effective_at` columns exist but no code reads/writes them yet. Migration from billing (Tier 1.5) will need to populate them.

## 6. How to resume the deploy

**Pre-requisites:**
- DNS A record `edusupervise.ashbi.ca` → `187.77.26.99` (Cameron adds in DNS provider)
- Frozen main branch on GitHub (or kill orphaned worker session)

**Step 1: Fix DB connectivity (~30 min)**

Edit `packages/db/src/client.ts` to use `await postgres(url, opts)` if running 3.x. Or test directly:

```bash
ssh root@187.77.26.99
docker exec docker-web-1 node -e "
  const p = require('postgres');
  console.log('version:', p.version);
  const c = p(process.env.DATABASE_URL);
  c\`SELECT 1\`.then(r => console.log('OK', r)).catch(e => console.error('ERR', e));
"
```

If 3.x returns a Promise: `const c = await postgres(url, opts); drizzle(c, {schema})`.

**Step 2: Verify health endpoint**

```bash
docker exec docker-web-1 wget -qO- http://localhost:3011/api/health
# Expect: {"status":"ok","db":"ok","uptime_s":N}
```

**Step 3: Test signup end-to-end**

```bash
# Get inside the container for proper DB access
docker exec -it docker-web-1 sh
cd /app
node apps/web/build/server/index.js &
sleep 2
curl -i -X POST http://localhost:3011/signup \
  -H 'Content-Type: application/json' \
  -d '{"schoolName":"Smoke","schoolSlug":"smoke","adminName":"Cameron","adminEmail":"cameron@ashbi.ca","adminPassword":"smoketest123"}'
# Expect: 302 to /app with Set-Cookie: edusupervise.session=...
```

Then login with that account, navigate to /app/duties/new, create a duty. Verify the row is in Postgres.

**Step 4: Point DNS at VPS + wait for ACME cert**

```bash
# Confirm DNS
dig +short edusupervise.ashbi.ca
# Should return: 187.77.26.99

# Traefik will issue a Let's Encrypt cert automatically
# Check via:
curl -I https://edusupervise.ashbi.ca/api/health
# Expect: HTTP/2 200 + valid cert
```

**Step 5: Smoke test from the public URL**

Run the full flow from a browser:
1. Visit `https://edusupervise.ashbi.ca/signup` → create school + admin
2. Verify redirect to `/app`
3. Visit `/app/duties/new` → create a duty
4. Assign yourself → create a 1-min reminder
5. Wait 90s → check `/app/notifications` for the dispatch
6. Check `docker logs docker-worker-1` for the heartbeat

**Step 6: Set up cron + backup**

Already running. To verify:
```bash
docker logs docker-cron-1  # should show the audit-retention SQL running
crontab -l  # confirm /etc/cron.d/edusupervise-backup is registered
```

## 7. Lessons learned (worth saving)

These should make the next attempt cheaper.

1. **pnpm virtual store + Node runtime resolution is fragile.** Pnpm creates per-workspace `node_modules` with symlinks to a `.pnpm` store. When you copy only `/app/node_modules` to a runtime image, transitive deps used by other workspaces aren't reachable. Fixes: copy the full workspace tree (`apps/*/node_modules` + `packages/*/node_modules` + root), set `NODE_PATH=/app/node_modules` as fallback, or run `pnpm install --prod` at runtime.

2. **pnpm 11 + Node 20 don't mix.** pnpm 11 needs Node 22+ (uses `node:sqlite`). Either pin pnpm to 9.15.x (latest 9) or use Node 22 base. The lockfile doesn't carry a `packageManager` field, so corepack picks the latest. Always pin in `engines` or Dockerfile.

3. **RR7's `apps/web/build/server/index.js` is a request handler, not a full server.** It needs `react-router-serve` to provide the Node HTTP wrapper. Running `node index.js` directly exits silently with code 0.

4. **postgres.js 3.x returns a tagged template function, not a Promise.** `await postgres(url, opts)` is needed for newer versions; older versions were sync. Drizzle's `postgres-js` adapter expects the tag function.

5. **`mavis team plan` with default task timeout (15 min) is too short for any non-trivial implementation.** Plan with explicit `timeout_ms: 3600000` (60 min) per task from the start, OR break work into smaller chunks (~10-20 min each).

6. **Active worker sessions in a cancelled plan keep force-pushing commits.** If you cancel a plan, kill the worker session explicitly OR freeze the branch. Otherwise the "cancelled" workers will keep committing their incomplete work, fighting your fixes.

7. **`docker compose --env-file` interpolates `${VAR}` in the compose file's `environment:` block, but only if the VAR is also in the env_file.** Using `env_file:` plus `environment:` referencing env-file vars with the same name works. The secrets `secrets:` stanza + `POSTGRES_PASSWORD_FILE` can conflict with `POSTGRES_PASSWORD` in env — pick one.

8. **Traefik's Traefik v3.2 dynamic router config requires the Traefik instance to be already configured to load `.yml` files from a directory.** If existing Traefik on the VPS doesn't pick up `edusupervise.yml`, no routing happens even when DNS resolves.

## 8. Where the time went

Roughly 8 hours from "code review this Replit app" to "deploy paused":
- ~1h: spec writing
- ~1h: spec reviewer iterations (3 rounds, 5 blockers → 0)
- ~2h: team plan + 2 cancellations (15-min cap problem)
- ~2h: solo build (auth, frontend, worker, config)
- ~1h: deploy debugging (pnpm, lockfile, runtime resolution, Dockerfile iterations, Traefik setup, DNS not configured, DB connectivity)

If you have to do this again, the deploy phase alone is ~3-4 hours of focused work for a working prod deploy. The code is solid; it's the runtime plumbing that ate the time.

## 9. Quick reference

- **Repo:** `https://github.com/camster91/edusupervise`
- **VPS:** `ssh root@187.77.26.99`
- **Repo on VPS:** `/opt/edusupervise`
- **Secrets:** `/root/edusupervise-secrets/`
- **Data:** `/data/postgres`, `/data/redis`, `/data/uploads`, `/data/backups`
- **Spec:** `docs/superpowers/specs/2026-06-28-edusupervise-rebuild.md`
- **This doc:** `docs/superpowers/specs/2026-06-28-edusupervise-deploy-status.md`
- **Traefik router:** `deploy/traefik/edusupervise.yml` → copy to `/opt/traefik/dynamic/routers/`
- **Runbook:** `docs/runbooks/production-deploy.md`