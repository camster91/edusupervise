# Account deletion cron (daily hard-delete)

App Store guideline 5.1.1(v) requires a working account-deletion
flow. We ship a request form + email confirmation + 30-day grace
period + a daily cron that hard-deletes users who passed the
grace period.

## Components

- **App routes:**
  - `GET/POST /account/delete` — email form. Calls
    `requestAccountDeletion(email)`.
  - `GET /account/delete/confirm?token=...` — token consumer.
    Calls `confirmAccountDeletion(rawToken)`.
  - `POST /api/admin/purge-account-deletions` — cron-only.
    Authenticated by the `X-Cron-Secret` header.
- **Server functions** in `apps/web/server/account-deletion.server.ts`:
  - `requestAccountDeletion` — mints a 32-byte base64url token,
    stores SHA-256 hash + 7-day expiry in
    `account_deletion_tokens`, sends the raw token in a Mailgun
    email link.
  - `confirmAccountDeletion` — validates the token (single-use,
    not expired), sets `users.pending_deletion_at = now() + 30
    days`, soft-deletes `push_subscriptions`, writes an
    `audit_log` entry with `action='account_deletion_confirmed'`.
  - `cancelAccountDeletion(userId)` — clears
    `pending_deletion_at` (Settings → Account → Cancel deletion
    in v1.1; the server function is shipped now so the route is
    a follow-up).
  - `purgeAccountDeletions` — hard-deletes all users with
    `pending_deletion_at < now()`. Used by the daily cron.
- **DB schema:**
  - Migration `0016_account_deletion` — adds
    `users.pending_deletion_at` + the `account_deletion_tokens`
    table + RLS+FORCE on the token table (defense in depth) +
    GRANTs for the system and runtime roles.
  - Migration `0017_cascade_created_by` — flips NO ACTION FKs
    on `duties.created_by`, `coverage_events.created_by`,
    `duty_assignments.created_by`,
    `duty_assignments.assigned_by_user_id`, `audit_log.user_id`
    to CASCADE so the single `DELETE FROM users` cleans up
    dependent rows atomically. `recurring_duties.created_by` is
    nullable and goes to SET NULL (the recurring template
    outlives the user; they just stop being attributed).

## Cron entry

`/etc/cron.d/edusupervise-deletion-purge`:

```
30 4 * * * root /root/edusupervise-secrets/daily-account-deletion-purge.sh >> /var/log/edusupervise-deletion-purge.log 2>&1
```

Offset from the existing edusupervise backup (03:17) and
simaqadeer backup (03:35) so the box isn't doing all three at
once.

## Cron script

`/root/edusupervise-secrets/daily-account-deletion-purge.sh`:

- Sources `CRON_SECRET` from `/root/edusupervise-secrets/.env`
  (chmod 600, root-only).
- POSTs to `https://edusupervise.ashbi.ca/api/admin/purge-account-deletions`
  with `X-Cron-Secret: $CRON_SECRET`.
- Logs the JSON response to
  `/var/log/edusupervise-deletion-purge.log`.
- On HTTP 200, writes a timestamp to
  `/var/lib/node_exporter/edusupervise_deletion_purge_last_success`
  (same pattern as the edusupervise backup; the metrics route
  can surface staleness alerts).
- Exits 1 on any other HTTP code or on missing CRON_SECRET.

## Secrets

`CRON_SECRET` is set in two places (must match):

- `/root/edusupervise-secrets/.env` — what the bash script reads.
  Chmod 600, owned by root.
- `/opt/edusupervise/docker/.env` — what the web container reads
  via `process.env.CRON_SECRET`. Chmod 644 (mounted into the
  container at `/app/.env`).

Both are 32 chars. The route does a constant-time compare
(`crypto.timingSafeEqual`) and refuses all requests when
`CRON_SECRET` is unset — the endpoint is disabled rather than
accepting any secret.

To rotate: `openssl rand -hex 16` in both files, then
`docker compose -f /opt/edusupervise/docker/docker-compose.yml -p docker up -d --build web`
to pick up the new env value.

## End-to-end verification (2026-07-13)

```
# Request
$ curl -X POST -d 'email=deploy.test@example.com' \
    http://127.0.0.1:3011/account/delete
→ 200 "Check your email"

# Mailgun storage returns the token
$ curl --user "api:$MAILGUN_API_KEY" "$STORAGE_URL"
→ TOKEN=GgIYZ7mt_zfLAH013uXL1BUBB3vbL-Afqiw1kc4wNNQ

# Confirm
$ curl "http://127.0.0.1:3011/account/delete/confirm?token=$TOKEN"
→ 200 "Deletion scheduled for 2026-08-12"
DB: is_active=f, pending_deletion_at=2026-08-12
DB: account_deletion_tokens.used_at set
DB: audit_log action=account_deletion_confirmed, metadata={deletion_at, grace_period_days:30, token_id}

# Purge (backdate 31 days, then call cron)
$ UPDATE users SET pending_deletion_at = now() - interval '31 days' WHERE email = 'deploy.test@example.com';
$ curl -X POST -H "X-Cron-Secret: $CRON_SECRET" \
    https://edusupervise.ashbi.ca/api/admin/purge-account-deletions
→ {"ok":true,"purged":1}
DB: user gone, dependent rows cascade-cleaned, audit_log row
    with action=account_deletion_purged (user_id=NULL) survives.
```
