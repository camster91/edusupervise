# EduSupervise Production Deploy Runbook

Step-by-step guide to deploy EduSupervise to vps.ashbi.ca from a fresh install.
Target audience: anyone with SSH access to the VPS. Estimated time: 30-45 minutes
including DNS propagation and ACME cert issuance.

## Prerequisites

- SSH access to vps.ashbi.ca (187.77.26.99) as a user with `sudo` and
  `docker` group membership
- The Traefik v3.2 instance already running on the VPS (per existing pattern
  on the VPS — see `deploy/traefik/edusupervise.yml`)
- DNS A record for `edusupervise.ashbi.ca` pointing at `187.77.26.99`
- Resend account with a verified sending domain (for production email)
- Twilio account with a phone number (for production SMS — optional at this
  stage if `SMS_PROVIDER=mock` is acceptable)
- Stripe account with two products pre-created (Pro $49/mo, School $199/mo)
- Stripe webhook endpoint registered (CLI: `stripe listen --forward-to
  https://edusupervise.ashbi.ca/api/billing/webhook` during setup, then
  production endpoint after deploy)

## Step 1 — Server prep

SSH in and create the deploy user if not already present:

```bash
ssh deploy@vps.ashbi.ca
sudo useradd -m -s /bin/bash edusupervise
sudo usermod -aG docker edusupervise
sudo mkdir -p /opt/edusupervise
sudo chown edusupervise:edusupervise /opt/edusupervise
```

## Step 2 — Clone the repo

```bash
sudo -iu edusupervise
cd /opt/edusupervise
git clone https://github.com/camster91/edusupervise.git .
git checkout main
```

## Step 3 — Generate secrets

Run the secret generator to produce the passwords and keys. Each value is a
random base64 string. **Save these somewhere safe (1Password / Bitwarden) —
losing any of them means rotating all sessions.**

```bash
mkdir -p /root/edusupervise-secrets
cd /root/edusupervise-secrets

# Postgres owner password (superuser, only used by init + drizzle-kit migrations)
openssl rand -base64 32 | tr -d '/+=' > postgres_password.txt
chmod 600 postgres_password.txt

# Postgres runtime + system role passwords (used by app containers)
openssl rand -base64 32 | tr -d '/+=' > runtime_password.txt
openssl rand -base64 32 | tr -d '/+=' > system_password.txt
chmod 600 runtime_password.txt system_password.txt

# Better-auth + session secrets
openssl rand -base64 32 | tr -d '/+=' > better_auth_secret.txt
openssl rand -base64 32 | tr -d '/+=' > session_secret.txt
chmod 600 better_auth_secret.txt session_secret.txt
```

## Step 4 — Write the .env file

`/root/edusupervise-secrets/.env`:

```bash
# Postgres passwords (used in compose URL interpolation)
EDUSUPERVISE_RUNTIME_PASSWORD=$(cat /root/edusupervise-secrets/runtime_password.txt)
EDUSUPERVISE_SYSTEM_PASSWORD=$(cat /root/edusupervise-secrets/system_password.txt)

# Auth
SESSION_SECRET=$(cat /root/edusupervise-secrets/session_secret.txt)
BETTER_AUTH_SECRET=$(cat /root/edusupervise-secrets/better_auth_secret.txt)

# Email (Resend)
RESEND_API_KEY=re_xxx                   # from Resend dashboard
RESEND_FROM_EMAIL=noreply@edusupervise.ashbi.ca

# SMS (Twilio) — optional, set SMS_PROVIDER=mock to skip
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_FROM_NUMBER=+15551234567
EMAIL_PROVIDER=resend
SMS_PROVIDER=twilio                     # or 'mock' to disable

# Billing (Stripe) — start with test mode, swap to live later
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_xxx           # or sk_live_xxx for prod
STRIPE_WEBHOOK_SECRET=whsec_xxx         # from `stripe listen` or dashboard
STRIPE_PRICE_PRO=price_xxx
STRIPE_PRICE_SCHOOL=price_xxx

# App
APP_URL=https://edusupervise.ashbi.ca
APP_HOST=edusupervise.ashbi.ca
NODE_ENV=production
LOG_LEVEL=info
```

`chmod 600 /root/edusupervise-secrets/.env`.

## Step 5 — Create data directories

```bash
sudo mkdir -p /data/postgres /data/redis /data/uploads /data/backups
sudo chown -R edusupervise:edusupervise /data
```

## Step 6 — Deploy the Traefik router

The Traefik dynamic config file goes wherever the existing Traefik v3.2 instance
picks up .yml files (typically `/opt/traefik/dynamic/routers/`):

```bash
sudo cp /opt/edusupervise/deploy/traefik/edusupervise.yml \
        /opt/traefik/dynamic/routers/edusupervise.yml
```

Traefik picks it up without a restart. Validate via:

```bash
curl -sI https://edusupervise.ashbi.ca/api/health
# expect: HTTP/2 404 (the app isn't running yet, but Traefik is routing)
```

## Step 7 — First boot

```bash
cd /opt/edusupervise
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
```

Watch logs for first-boot errors:

```bash
docker compose -f docker/docker-compose.yml logs -f web
```

Healthy state:
- `postgres` reports `database system is ready to accept connections`
- `redis` reports `Ready to accept connections`
- `cron` reports `apk add postgresql16-client` then sleeps
- `web` reports `pnpm migrate` succeeded then RR7 starts listening on :3000
- `worker` reports BullMQ worker started, heartbeat row inserted

## Step 8 — Verify the deploy

```bash
# Health check
curl -sS https://edusupervise.ashbi.ca/api/health | jq

# Sign up a school via curl
curl -sS -X POST https://edusupervise.ashbi.ca/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"school":{"name":"Production Test","slug":"prod-test"},"admin":{"email":"cameron@ashbi.ca","password":"REPLACE_ME","name":"Cameron"}}'

# Log in via the UI at https://edusupervise.ashbi.ca/login
```

## Step 9 — Configure backups

```bash
sudo install -m 755 /opt/edusupervise/deploy/backup.sh /usr/local/bin/edusupervise-backup
echo "0 3 * * * root /usr/local/bin/edusupervise-backup >> /var/log/edusupervise-backup.log 2>&1" \
  | sudo tee /etc/cron.d/edusupervise-backup
```

`backup.sh` writes to `/data/backups/` and rsyncs to offsite (Backblaze B2 by
default — adjust the script if you want a different target). Retains 30 daily
+ 12 monthly.

## Step 10 — Stripe webhook in production

In the Stripe dashboard:

1. Go to Developers → Webhooks → Add endpoint.
2. Endpoint URL: `https://edusupervise.ashbi.ca/api/billing/webhook`
3. Events to send: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`
4. Copy the signing secret to `STRIPE_WEBHOOK_SECRET` in `/root/edusupervise-secrets/.env`.
5. Restart the web container: `docker compose -f docker/docker-compose.yml restart web`.

## Step 11 — Smoke test

Run a full flow:

1. Sign up a new school at https://edusupervise.ashbi.ca/signup
2. Log in
3. Create a duty at Main Entrance 08:30 (Day 1)
4. Assign yourself to the duty
5. Create a 1-minute reminder
6. Wait 90 seconds
7. Check `/app/notifications` for the dispatched reminder
8. Check `/app/settings/audit` for the audit log entries
9. Verify the email landed in the Resend dashboard (or in the inbox)

If all 9 steps pass, Tier 1 is shipped.

## Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| 404 from `https://edusupervise.ashbi.ca/api/health` | Traefik not routing OR web container crashed | Check `docker compose logs web`, check Traefik logs at `/var/log/traefik/` |
| 500 on signup | Postgres roles not created (init script didn't run) | Re-run `docker exec postgres bash /docker-entrypoint-initdb.d/00-create-roles.sh` |
| Login fails with "school not found" | `app.school_id` not propagated in session | Application bug — check `withSchoolContext` is wrapping the query in `apps/web/server/db.server.ts` |
| Reminders not firing | worker container down OR outbox flusher stalled | `docker compose logs worker`; check `worker_heartbeats` table for last_beat freshness |
| Stripe webhook 400 | Wrong STRIPE_WEBHOOK_SECRET OR missing stripe_events insert | Verify the env var matches dashboard; check `stripe_events` table for the event.id |
| ACME cert issuance failed | DNS not pointing at VPS OR rate limit | `dig +short edusupervise.ashbi.ca` should return `187.77.26.99`; check Traefik cert resolver logs |

## Rollback

If the deploy is broken and you need to roll back to a previous image:

```bash
cd /opt/edusupervise
git log --oneline -10          # find the last good commit
git checkout <good-commit>
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
```

Database state is preserved (postgres volume at `/data/postgres`). To roll back
the database too, follow `docs/runbooks/restore.md` with the latest
`/data/backups/edusupervise-*.dump`.