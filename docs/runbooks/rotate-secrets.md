# Rotate secrets runbook

When a provider key is compromised, an employee with access leaves, or
you simply want to enforce a rotation cadence, use this runbook.
All secrets live in `/root/edusupervise-secrets/.env` on the VPS;
the `web`, `worker`, and `cron` containers pick them up via Docker
`env_file`. The `postgres` container also reads `.env` (added in
`devops-deploy`) for role-password env vars.

## TL;DR

| Secret | Session impact | How to rotate |
|--------|----------------|---------------|
| `STRIPE_SECRET_KEY` | None | `install.sh`, restart web+worker. |
| `STRIPE_WEBHOOK_SECRET` | None | `install.sh`, restart web. **Also update the Stripe dashboard.** |
| `RESEND_API_KEY` | None | `install.sh`, restart web+worker. |
| `TWILIO_AUTH_TOKEN` | None | `install.sh`, restart web+worker. |
| `BETTER_AUTH_SECRET` | Sessions invalidated (sign-out) | `install.sh`, restart web. **Rotate at 03:00 local time** to minimize user impact. |
| `SESSION_SECRET` | Same as `BETTER_AUTH_SECRET` | Same. |
| `POSTGRES_PASSWORD` (owner, in `postgres_password.txt` only) | All connections drop for ~10s during restart | `ALTER ROLE` in place + rewrite the secret file (see below). NOT in `.env` — owner password lives only in `/root/edusupervise-secrets/postgres_password.txt` (the docker secret mount). |
| `EDUSUPERVISE_RUNTIME_PASSWORD` | Web connections drop | `install.sh`, restart web. |
| `EDUSUPERVISE_SYSTEM_PASSWORD` | Worker/cron connections drop | `install.sh`, restart worker+cron. |

`install.sh` is idempotent: it preserves all existing values and only
prompts for the key you pass (or that is empty). To rotate a single
key, run `install.sh` and update the value at the prompt.

## General procedure

1. SSH to the VPS as the deploy user.
2. `cd /opt/edusupervise` (or wherever the repo is checked out).
3. `sudo /opt/edusupervise/deploy/install.sh` — this reads the existing
   `.env` and only prompts for missing values. To rotate one key, just
   overwrite its value at the prompt.
4. `sudo docker compose -f docker/docker-compose.yml restart <services>` —
   see the per-secret table for which services need a restart.
5. Verify the new key works (see "Verify" section for each secret).

The install script's `write_kv` helper preserves any keys you don't
touch, so you can rotate one secret without losing the others.

## Per-secret details

### `STRIPE_SECRET_KEY`

- **Used by:** web (checkout, portal, refund) and worker (none directly,
  but the value is in the env for consistency).
- **Session impact:** none. Stripe API calls use the new key on the
  next request after the web container restarts.
- **Procedure:**

  ```bash
  # 1. Roll the key in the Stripe dashboard:
  #    https://dashboard.stripe.com/apikeys -> "Roll key" (live mode)
  # 2. Install.sh prompts; paste the new key.
  sudo /opt/edusupervise/deploy/install.sh
  #    STRIPE_SECRET_KEY [default: sk_live_...]: sk_live_NEWKEY...
  # 3. Restart.
  sudo docker compose -f docker/docker-compose.yml restart web worker
  # 4. Verify with a test checkout (Stripe test mode) or by looking
  #    for a successful 200 from a billing.server.ts helper in
  #    `docker logs edusupervise-web-1 --tail 200`.
  ```

### `STRIPE_WEBHOOK_SECRET`

- **Used by:** web (`api.billing.webhook.tsx`). Different from
  `STRIPE_SECRET_KEY` — this is the **endpoint secret** Stripe uses to
  HMAC-sign webhook payloads.
- **Session impact:** none. But webhooks that arrive during the
  rotation window get `INVALID_SIGNATURE` and are dropped.
- **Procedure:**

  1. In the Stripe dashboard, the webhook endpoint
     (`https://edusupervise.ashbi.ca/api/billing/webhook`) has a
     "Roll secret" button under the endpoint detail. Click it; copy
     the new `whsec_...`.
  2. `install.sh`, paste the new value.
  3. `sudo docker compose -f docker/docker-compose.yml restart web`.
  4. Verify by sending a test event from the Stripe dashboard
     ("Send test event") — it should appear in `audit_log` with
     `action='billing.webhook.received'` within a second.

### `RESEND_API_KEY`

- **Used by:** web (outgoing email). The worker also has it in env
  but only the web server sends via Resend.
- **Session impact:** none.
- **Procedure:**

  1. Create a new API key in the Resend dashboard
     (https://resend.com/api-keys).
  2. `install.sh`, paste the new key.
  3. `sudo docker compose -f docker/docker-compose.yml restart web worker`.
  4. Verify by sending a test email: log in as a teacher, click
     "Send test reminder" on a duty. Confirm the email arrives within
     ~30s (mock provider is fast; real Resend is usually <5s).

### `TWILIO_AUTH_TOKEN`

- **Used by:** web (outgoing SMS). Worker has it in env for
  consistency.
- **Session impact:** none.
- **Procedure:**

  1. In the Twilio console, go to Account -> API keys & tokens,
     click the "Regenerate" button next to the Auth Token.
  2. `install.sh`, paste the new token.
  3. `sudo docker compose -f docker/docker-compose.yml restart web worker`.
  4. Verify by sending a test SMS (admin -> teacher with phone verified).

### `BETTER_AUTH_SECRET`

- **Used by:** web (better-auth session signing + CSRF).
- **Session impact:** **YES.** All signed cookies (sessions and CSRF
  tokens) become invalid the moment the secret rotates. Users are
  silently signed out on their next request.
- **Mitigation:** rotate at 03:00 local time. With a 30-day session
  TTL, a small percentage of users are signed out (~1/30 of active
  sessions per day). If you have <100 daily active users, the absolute
  number of people affected is small.
- **Future improvement (Tier 2):** modify `apps/web/server/auth.server.ts`
  to accept `BETTER_AUTH_SECRET` AND `BETTER_AUTH_SECRET_OLD`, and try
  both during verification. This is a one-line change in
  auth-rls's territory; until then, accept the brief sign-out.
- **Procedure:**

  ```bash
  # 1. Generate a new secret:
  NEW_SECRET=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)
  # 2. Edit /root/edusupervise-secrets/.env:
  sudo sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${NEW_SECRET}|" \
    /root/edusupervise-secrets/.env
  # 3. Restart web:
  sudo docker compose -f docker/docker-compose.yml restart web
  # 4. Verify by visiting https://edusupervise.ashbi.ca/login — old
  #    sessions are signed out, fresh login works.
  ```

### `SESSION_SECRET`

- **Used by:** web (any express/cookie session signing not handled by
  better-auth — currently unused in Tier 1, but reserved for future
  use, e.g. flash messages across redirects).
- **Session impact:** same as `BETTER_AUTH_SECRET`.
- **Procedure:** same as `BETTER_AUTH_SECRET`. If you're not actively
  using `SESSION_SECRET`, you can rotate it freely (it has no effect).

### Postgres role passwords

- **Used by:** web (runtime), worker+cron (system), and the postgres
  init script on first boot.
- **Session impact:** yes — the web/worker/cron containers drop their
  DB connection pool and reconnect with the new credentials. Brief
  5xx errors during the ~5s restart.
- **Procedure:**

  ```bash
  # 1. Generate new passwords:
  NEW_OWNER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)
  NEW_RUNTIME=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)
  NEW_SYSTEM=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)
  # 2. Update .env runtime + system passwords (install.sh prompts;
  #    the OWNER password is NOT prompted because it doesn't go in .env):
  sudo /opt/edusupervise/deploy/install.sh
  #    EDUSUPERVISE_RUNTIME_PASSWORD [default: ...]: ${NEW_RUNTIME}
  #    EDUSUPERVISE_SYSTEM_PASSWORD  [default: ...]: ${NEW_SYSTEM}
  #    (skip the OWNER prompt — there's none; you set it in step 4)
  # 3. Apply the new passwords to the running Postgres (no restart needed
  #    for password changes themselves, just for the env var pickup):
  sudo docker exec edusupervise-postgres-1 psql -U edusupervise_owner -d edusupervise <<EOSQL
  ALTER ROLE edusupervise_owner    WITH PASSWORD '${NEW_OWNER}';
  ALTER ROLE edusupervise_runtime  WITH PASSWORD '${NEW_RUNTIME}';
  ALTER ROLE edusupervise_system   WITH PASSWORD '${NEW_SYSTEM}';
  EOSQL
  # 4. Rewrite the owner password docker secret file (this is the ONLY
  #    place the owner password lives on the host — never in .env):
  echo -n "${NEW_OWNER}" | sudo tee /root/edusupervise-secrets/postgres_password.txt >/dev/null
  sudo chmod 0600 /root/edusupervise-secrets/postgres_password.txt
  # 5. Restart the stack so the web/worker/cron containers pick up the
  #    new runtime/system passwords from .env:
  sudo docker compose -f docker/docker-compose.yml restart
  # 6. Verify with deploy/healthcheck.sh:
  /opt/edusupervise/deploy/healthcheck.sh
  ```

## Verify after rotation

Always run a smoke test after rotating a secret:

```bash
# 1. Healthcheck
/opt/edusupervise/deploy/healthcheck.sh  # exit 0 = ok

# 2. Login as a test user
curl -fsS -c /tmp/cookies.txt -b /tmp/cookies.txt \
  -X POST https://edusupervise.ashbi.ca/api/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@maple.test","password":"password123"}' && echo "  login ok"

# 3. If you rotated a billing secret, send a Stripe test event from
#    the dashboard and check the audit log.
```

If anything fails, see `docs/runbooks/incident-debug.md`.

## Rotation cadence

Recommended:

| Secret | Cadence | Trigger |
|--------|---------|---------|
| `STRIPE_SECRET_KEY` | Annually, or on staff departure | Compliance policy |
| `STRIPE_WEBHOOK_SECRET` | On compromise only | Suspected leak |
| `RESEND_API_KEY` | Annually | Compliance policy |
| `TWILIO_AUTH_TOKEN` | On staff departure | Compliance policy |
| `BETTER_AUTH_SECRET` | Quarterly | Hygiene |
| `SESSION_SECRET` | Annually | Hygiene |
| Postgres passwords | Annually, or on staff departure | Compliance policy |

Document the rotation in `audit_log` with `action='secret.rotated'`
(system role) so you have a history. (This is a Tier 2 nice-to-have;
not yet wired in Tier 1.)
