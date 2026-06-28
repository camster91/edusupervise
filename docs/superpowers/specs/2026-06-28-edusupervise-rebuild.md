# EduSupervise Rebuild — Design Spec (v2)

**Date:** 2026-06-28
**Status:** Draft v2, post-review iteration 1 (5 blockers + 7 important + 8 nits + 3 gaps addressed)
**Author:** Mavis (orchestrator)
**Decider:** Cameron Ashley
**Target ship:** Tier 1 in 4-6 weeks, Tier 2 in weeks 6-10, Tier 3 in months 3-6

## 1. Overview

EduSupervise is a multi-tenant SaaS that lets K-12 schools schedule teacher supervision duties (before/after school, recess, lunch, bus dismissal) on a recurring cycle, then automatically reminds the assigned teachers by email and SMS.

**Single deployment = one school per database instance.** Multi-school SaaS (district-level tenancy) lives in Tier 3. Each Tier 1 ship is a deployable product one school can use end-to-end.

### Success criteria for Tier 1

1. A school admin can self-signup, get a 30-day free trial, and onboard teachers via CSV upload or manual entry.
2. The admin can define the school's cycle calendar (5-day, 6-day, or custom) and mark non-school days.
3. The admin can CRUD duties (time, location, duration, equipment needed) and assign teachers to them with date ranges.
4. Each teacher can log in, see their schedule for any week, and configure reminders (X minutes before, with email and/or SMS channels).
5. Reminders fire on schedule via the BullMQ worker. Each send is logged in `reminder_log` and visible to the admin.
6. The admin can view an audit log of every state change.
7. The admin can upgrade from free to a paid Stripe plan; the system enforces plan limits.
8. Each school's branding (logo, accent color) appears in their UI; data is isolated from other schools by Postgres RLS.
9. End-to-end smoke test (signup → assign duty → create reminder → receive email) passes on a fresh VPS deploy.
10. Manual teacher creation works (not just CSV / invite-only).

### Non-goals (explicit)

- Native mobile apps (Tier 3)
- District-level multi-tenancy (Tier 3)
- Parent / student portal (Tier 3)
- AI-assisted duty scheduling (Tier 3)
- Real-time collaborative editing
- Self-hosted single-tenant install (Tier 3 — for now, all tenants share the SaaS)

## 2. Architecture

```
vps.ashbi.ca (187.77.26.99, minimum 4 vCPU / 8 GB RAM / 80 GB NVMe)
└── Traefik v3.2 (existing)
    └── edusupervise.ashbi.ca → web container (port 3000, internal only)

Containers (docker compose, all on internal network):
├── web        React Router 7 SSR + RR7 resource routes for /api/*, port 3000
├── worker     BullMQ worker, no public port
├── postgres   PostgreSQL 16 with three roles (owner / runtime / system), port 5432
└── redis      Redis 7, port 6379

Volumes:
├── /data/postgres         pgdata (WAL + base)
├── /data/redis            appendonly.aof
├── /data/uploads          per-school logo files
└── /data/backups          nightly pg_dump + WAL archive

Secrets:
└── /root/edusupervise-secrets/.env   SESSION_SECRET, BETTER_AUTH_SECRET,
                                       RESEND_API_KEY, RESEND_FROM_EMAIL,
                                       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
                                       TWILIO_FROM_NUMBER,
                                       STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
                                       STRIPE_PRICE_PRO, STRIPE_PRICE_SCHOOL,
                                       DATABASE_URL, REDIS_URL, APP_URL,
                                       NODE_ENV, LOG_LEVEL
```

### Postgres role separation (CRITICAL — multi-tenancy boundary)

Three distinct roles are created on first Postgres init:

| Role | Owner of tables? | `BYPASSRLS`? | Used by |
|------|-----------------|---------------|---------|
| `edusupervise_owner` | Yes | No (uses `FORCE`) | Migrations only |
| `edusupervise_runtime` | No | No | Web container |
| `edusupervise_system` | No | **Yes** | Worker, webhooks, cron |

The runtime role does NOT own tables, so `FORCE ROW LEVEL SECURITY` actually enforces policies against it. The system role has `BYPASSRLS` and is the only writer of `audit_log` for system-initiated actions (webhook handlers, the reminder worker, scheduled jobs). It is also the only role that writes to `stripe_events`, `worker_heartbeats`, and `plan_limits`.

### Request flow (typical web mutation)

1. Browser POSTs to React Router action at `/app/duties/new`
2. Action validates CSRF (double-submit cookie + header) and Zod schema
3. Action opens Drizzle transaction using `edusupervise_runtime` connection
4. Action calls `SET LOCAL app.school_id = '<schoolId>'` (from authenticated session)
5. RLS policies filter all queries to the current school
6. Mutation runs; `audit_log` row written in same transaction
7. Transaction commits
8. If the mutation affects reminders, a transactional outbox row is inserted; the same transaction commits both the data change and the outbox entry
9. A separate BullMQ enqueueer (in the web container, runs every 5s) reads outbox rows and adds jobs to Redis

### Request flow (reminder dispatch)

1. Worker picks up `reminder.dispatch` job at scheduled time
2. Worker validates job payload via Zod: `{ schoolId: UUID, reminderId: UUID, assignmentId: UUID, userId: UUID, channel: 'email'|'sms', scheduledFor: ISO8601 }` — missing `schoolId` is a hard error
3. Worker opens DB transaction using `edusupervise_system` connection (which has `BYPASSRLS`, but the worker doesn't rely on it)
4. Worker sets `SET LOCAL app.school_id = job.schoolId` defensively — even with `BYPASSRLS`, this makes the worker's intent explicit and matches the runtime path
5. Worker reads assignment, user contact info, school branding (RLS still applies for reads since worker uses runtime connection role for reads; writes go through system role only for `audit_log`, `reminder_log`, `worker_heartbeats`)
6. Worker calls Resend (email) and/or Twilio (SMS) API
7. On success: writes `reminder_log` row with status `sent`
8. On failure: BullMQ retries with exponential backoff (1m, 5m, 30m, 2h, 12h); after 5 failed attempts, writes `reminder_log.status = 'failed'` and writes `audit_log`

### Stripe webhook flow

1. Stripe POSTs to `https://edusupervise.ashbi.ca/api/billing/webhook`
2. RR7 resource route validates signature with `STRIPE_WEBHOOK_SECRET`
3. Handler opens DB transaction as `edusupervise_system`
4. INSERT into `stripe_events` (id = `event.id`, UNIQUE constraint) — if duplicate, abort (already processed)
5. Apply state change (plan update, subscription deletion, etc.)
6. INSERT into `audit_log`
7. Commit — both the dedup record and the state change are atomic

## 3. Stack (pinned)

### Runtime

| Package | Version | Why |
|---------|---------|-----|
| Node.js | 20 LTS | Stable, ESM, native fetch |
| TypeScript | ^5.6.0 | Strict, no `any` |
| pnpm | ^9.0 | Workspace-aware, fast |

### Web framework

| Package | Version | Why |
|---------|---------|-----|
| react-router | ~7.1.0 | Remix successor; SSR + loaders + actions |
| @react-router/node | ~7.1.0 | Node adapter |
| @react-router/serve | ~7.1.0 | Production server |
| react | ^18.3.0 | Stable |
| react-dom | ^18.3.0 | Stable |

### UI

| Package | Version | Why |
|---------|---------|-----|
| tailwindcss | ^3.4 | Utility CSS, matches existing visual vocabulary |
| @radix-ui/react-* | latest | Accessible primitives |
| lucide-react | ^0.460 | Icons |
| class-variance-authority | ^0.7 | Variant system |
| clsx | ^2.1 | className concat |
| tailwind-merge | ^2.5 | Conditional className merging |

### Forms + validation

| Package | Version | Why |
|---------|---------|-----|
| react-hook-form | ^7.53 | Performant, uncontrolled by default |
| @hookform/resolvers | ^3.9 | Zod adapter for react-hook-form |
| zod | ^3.23 | Schema validation, shared client + server |

### Data fetching

| Package | Version | Why |
|---------|---------|-----|
| @tanstack/react-query | ^5.59 | Client-side cache, mutations, optimistic updates |

### Database

| Package | Version | Why |
|---------|---------|-----|
| postgres | ^3.4 | Postgres client (lighter than pg) |
| drizzle-orm | ~0.36.0 | TypeScript-first ORM (pin minor) |
| drizzle-kit | ~0.28.0 | Migration generator (pin minor) |
| @electric-sql/pglite | ^0.2 | Optional: in-memory Postgres for tests |

### Cache + queue

| Package | Version | Why |
|---------|---------|-----|
| ioredis | ^5.4 | Redis client |
| bullmq | ^5.21 | Job queue with retry/backoff |

### Auth

| Package | Version | Why |
|---------|---------|-----|
| better-auth | **~1.6.14** | Pinned minor. 1.6.x is current stable as of mid-2026 with monthly security updates. Renovate opens PRs only against `~1.6.x`. |

### Billing

| Package | Version | Why |
|---------|---------|-----|
| stripe | ~17.0.0 | Server SDK (pin minor) |
| @stripe/stripe-js | ^4.10 | Client SDK |

### Email + SMS

| Package | Version | Why |
|---------|---------|-----|
| resend | ^4.0 | Email API |
| @react-email/components | ^0.0.31 | React Email templates |
| twilio | ^5.3 | SMS API |

### Server utilities

| Package | Version | Why |
|---------|---------|-----|
| helmet | ^8.0 | Security headers (used inside RR7 entry.server.tsx) |
| pino | ^9.5 | Structured JSON logs |
| zod | (shared) | Validation |

**Note:** No Express. RR7's `@react-router/serve` + RR7 resource routes handle all HTTP. Adding Express would mean two HTTP layers, two cookie parsers, two body parsers, ordering bugs.

### Logging strategy

`app/entry.server.tsx` wraps every request in a `pino` child logger with a `requestId`. Loaders and actions receive the logger via `context.get('logger')`. The worker logs job lifecycle via the same logger pattern, with `jobId` and `schoolId` on every line.

### Testing

| Package | Version | Why |
|---------|---------|-----|
| vitest | ^2.1 | Fast unit tests |
| @testing-library/react | ^16.0 | Component tests |
| @testing-library/user-event | ^14.5 | Interaction simulation |
| @playwright/test | ^1.48 | E2E |
| supertest | ^7.0 | HTTP integration tests |

### Tooling

| Package | Version | Why |
|---------|---------|-----|
| prettier | ^3.3 | Formatter |
| eslint | ^9.13 | Linter (flat config) |
| @typescript-eslint/parser | ^8.12 | TS parser for ESLint |
| @typescript-eslint/eslint-plugin | ^8.12 | TS rules |
| eslint-plugin-react | ^7.37 | React rules |
| eslint-plugin-react-hooks | ^5.0 | Hooks rules |

## 4. Data model

All tables in `public` schema. Every tenant-owned table has `school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE`. RLS is **enabled AND forced** so even the table-owning role is subject to policies (which matters because the runtime role doesn't own tables, but defense-in-depth requires FORCE).

### Migration discipline (REQUIRED for adding new tenant tables in Tier 2+)

When a future migration adds a tenant table:

1. `CREATE TABLE` (with `school_id NOT NULL`)
2. Backfill `school_id` for any rows (with explicit transaction, NOT inside the migration script's auto-commit)
3. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
4. `ALTER TABLE ... FORCE ROW LEVEL SECURITY`
5. `CREATE POLICY tenant_isolation ON <table> USING (school_id = current_school_id()) WITH CHECK (school_id = current_school_id())`
6. Integration test: verify a user from school A reads/writes nothing in school B's rows on the new table

### Schema

```sql
-- =========================================
-- Tenancy
-- =========================================

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  cycle_days INTEGER NOT NULL DEFAULT 5 CHECK (cycle_days BETWEEN 1 AND 10),
  school_year_start DATE NOT NULL,
  school_year_end DATE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'free', 'pro', 'school')),
  trial_ends_at TIMESTAMPTZ,
  plan_downgrade_pending_to TEXT,            -- when set, plan changes on this date
  plan_downgrade_effective_at TIMESTAMPTZ,   -- when set, retention is held until this date
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  logo_url TEXT,
  accent_color TEXT DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (school_year_end > school_year_start),
  CHECK (school_year_end <= school_year_start + interval '14 months')
);

CREATE INDEX idx_schools_slug ON schools(slug);

-- =========================================
-- Users + auth
-- =========================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('school_admin', 'teacher', 'substitute')),
  phone TEXT,
  phone_verified_at TIMESTAMPTZ,
  avatar_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(school_id, email)
);

CREATE INDEX idx_users_school_id ON users(school_id);
CREATE INDEX idx_users_email ON users(email);

-- Sessions and password_reset tokens are owned by better-auth.

-- =========================================
-- Cycle calendar
-- =========================================

CREATE TABLE cycle_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  cycle_day INTEGER, -- 1..cycle_days; null = non-school day
  is_school_day BOOLEAN NOT NULL DEFAULT true,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(school_id, date)
);

CREATE INDEX idx_cycle_calendar_school_date ON cycle_calendar(school_id, date);

-- =========================================
-- Duties
-- =========================================

CREATE TABLE duties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  cycle_day INTEGER NOT NULL CHECK (cycle_day >= 1),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  requires_vest BOOLEAN NOT NULL DEFAULT false,
  requires_radio BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE INDEX idx_duties_school_cycle ON duties(school_id, cycle_day) WHERE is_active;

-- =========================================
-- Duty assignments (teacher <-> duty with date range)
-- =========================================

CREATE TABLE duty_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  duty_id UUID NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX idx_assignments_school_user ON duty_assignments(school_id, user_id);
CREATE INDEX idx_assignments_school_duty ON duty_assignments(school_id, duty_id);

-- Cycle-math sanity check enforced at the application layer (see Section 17):
--   start_date >= schools.school_year_start
--   end_date <= schools.school_year_end  (or NULL)
-- Postgres CHECK can't reference schools easily; the application validates on insert/update.

-- =========================================
-- Reminders
-- =========================================

CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL CHECK (minutes_before >= 0 AND minutes_before <= 10080),
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_sms BOOLEAN NOT NULL DEFAULT false,
  custom_message TEXT CHECK (custom_message IS NULL OR length(custom_message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminders_school_assignment ON reminders(school_id, assignment_id);

-- =========================================
-- Reminder dispatch log
-- =========================================

CREATE TABLE reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  reminder_id UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reminder_id, scheduled_for, channel)  -- idempotency on concurrent dispatch
);

CREATE INDEX idx_reminder_log_school_status ON reminder_log(school_id, status);
CREATE INDEX idx_reminder_log_assignment ON reminder_log(assignment_id);

-- =========================================
-- Outbox (transactional queueing)
-- =========================================

CREATE TABLE outbox (
  id UUIDSERIAL PRIMARY KEY,
  school_id UUID NOT NULL,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox(created_at) WHERE enqueued_at IS NULL;

-- =========================================
-- Audit log
-- =========================================

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_school_created ON audit_log(school_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_log(school_id, target_type, target_id);

-- =========================================
-- Stripe webhook idempotency
-- =========================================

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,                       -- Stripe event.id
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================
-- Worker health (system-only, no RLS, single-row upserts per worker)
-- =========================================

CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  last_beat TIMESTAMPTZ NOT NULL,
  jobs_completed BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL
);

-- =========================================
-- Plan limits (global lookup, no RLS)
-- =========================================

CREATE TABLE plan_limits (
  plan TEXT PRIMARY KEY,
  max_teachers INTEGER NOT NULL,
  max_duties INTEGER NOT NULL,
  max_reminders_per_assignment INTEGER NOT NULL,
  sms_included BOOLEAN NOT NULL DEFAULT false,
  audit_retention_days INTEGER NOT NULL
);

INSERT INTO plan_limits VALUES
  ('trial',  5,   20,  3, false, 14),
  ('free',   3,   10,  1, false, 7),
  ('pro',   50,  500, 10, true,  90),
  ('school', 500, 5000, 50, true, 365);

-- =========================================
-- RLS — enable AND force on every tenant-owned table
-- =========================================

CREATE OR REPLACE FUNCTION current_school_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Each tenant table: ENABLE then FORCE then POLICY
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'cycle_calendar', 'duties', 'duty_assignments',
    'reminders', 'reminder_log', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (school_id = current_school_id()) '
      'WITH CHECK (school_id = current_school_id())',
      t
    );
  END LOOP;
END $$;

-- Schools table: a user can see their own school only
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;
CREATE POLICY school_self ON schools
  USING (id = current_school_id())
  WITH CHECK (id = current_school_id());

-- Global tables (no RLS needed): plan_limits, stripe_events, worker_heartbeats, outbox
-- (outbox entries always carry school_id and are filtered in the application layer)
```

### Multi-tenancy propagation

Every request that touches tenant data calls:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.school_id = ${schoolId}`);
  // ... all queries here are RLS-protected
});
```

`schoolId` comes from the authenticated session. A user cannot access another school's data even if they craft malicious URLs — Postgres enforces the boundary via `FORCE ROW LEVEL SECURITY`. The runtime role does not own the tables, so FORCE is necessary, not just defense-in-depth.

## 5. Auth

**Library:** better-auth ~1.6.14

**Methods supported:**
- Email + password (bcrypt, 12 rounds)
- Magic link via email (passwordless) — **consumed via POST not GET**
- Google OAuth (school admins)
- Microsoft OAuth (school admins)

**Sessions:** stored in Postgres via better-auth's session adapter. Cookie config:

```
Name: __Host-edusupervise.session
HttpOnly: true
Secure: true (prod only)
SameSite: Lax
Max-Age: 30 days
Path: /
```

**Password reset:** `POST /auth/forgot` sends a signed token (HMAC-SHA256, 1-hour TTL, single-use) via Resend. **Token is consumed via `POST /auth/reset` with `{ token, newPassword }` in body, not via GET URL.** This avoids token leakage via `Referer` header and browser history.

**Email verification:** `POST /auth/verify-email` with `{ token }` in body. School admins must verify before sending invites.

**Magic link:** `POST /auth/magic` with `{ token }` in body. Form submit pattern only — no GET-based consumption.

**Phone verification:** for SMS reminders, the teacher must verify their phone via a one-time code sent via Twilio Verify.

### CSRF (double-submit cookie pattern)

Cookies:

```
__Host-edusupervise.csrf
HttpOnly: false   ← MUST be readable by JS for double-submit
Secure: true
SameSite: Lax
Path: /
Value: 32-byte base64url random, set on first GET, rotated on login
```

Client behavior (`app/lib/api.ts`):
- On every mutation `fetch`, read `document.cookie`, extract the `csrf` value, set `x-csrf-token` header
- React Router form actions: helper `getCsrfToken(request)` extracts from cookie and compares to `x-csrf-token` body field

Server behavior (RR7 actions / resource routes):
- Extract token from `x-csrf-token` header (or form body for actions)
- Extract cookie value from `__Host-edusupervise.csrf`
- Compare using `crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookie))`
- Reject (403) on mismatch, missing token, or token age > 24h
- **Cross-origin form POST test** (origin != `APP_URL`) must return 403

**Rate limits:**
- Login: 5 attempts / 15 min / IP
- Forgot password: 3 / hour / email
- Magic link: 5 / hour / email
- Phone verification: 5 / hour / phone

## 6. Billing

**Library:** stripe ~17.0.0

### Plans

| Plan | Price | Teachers | Duties | SMS | Audit retention |
|------|-------|----------|--------|-----|-----------------|
| Trial | Free 30 days | 5 | 20 | No | 14 days |
| Free | $0 forever | 3 | 10 | No | 7 days |
| Pro | $49/mo per school | 50 | 500 | Yes | 90 days |
| School | $199/mo per school | 500 | 5,000 | Yes | 365 days |

### Flow

1. School signs up → trial plan, 30 days, full Pro features
2. Trial ends → auto-downgrade to Free (silent, no audit retention change since Trial=14d → Free=7d is a small drop, and Trial users haven't paid)
3. Admin clicks "Upgrade" → Stripe Checkout (Pro or School)
4. Stripe webhook `checkout.session.completed` → server updates `schools.plan` + `stripe_subscription_id` (transactional with `stripe_events` insert)
5. Stripe webhook `customer.subscription.deleted` → **Pro/School → Free is a destructive downgrade** — see policy below
6. Stripe webhook `invoice.payment_failed` → mark school `past_due`, banner, hard limit after 7 days

### Plan downgrade policy (destructive path: Pro/School → Free)

When a school downgrades from a paid plan to Free, the existing data exceeds the Free limits. The system:

1. Does NOT delete any data immediately.
2. Sets `schools.plan_downgrade_pending_to = 'free'` and `schools.plan_downgrade_effective_at = now() + interval '7 days'` on the day the downgrade is detected.
3. Renders a banner at the top of the admin UI: "Your subscription has ended. Data retention beyond Free plan limits will be reduced on `effective_at`. Export your audit log now."
4. Provides a one-click "Export audit log (CSV)" action during the 7-day grace period.
5. On `effective_at`, the nightly cron:
   - Updates `schools.plan = 'free'`
   - Clears `plan_downgrade_pending_to` and `plan_downgrade_effective_at`
   - Audit log retention cron (see below) becomes active for the school
6. Existing `reminder_log`, `audit_log`, etc. are NOT deleted in this pass — they exceed the limit and continue to be visible until the retention cron purges them per Free plan rules (7d).
7. Mutations on Free are still blocked when over Free limits (return 403; see below).

Trial → Free and Free → Free downgrades have no grace period (silent, on schedule).

### Plan enforcement (mutations)

Every mutation checks `plan_limits` for the school's current plan. If the limit is hit, return:

```
HTTP 403 Forbidden
Content-Type: application/json
{
  "error": "plan_limit_exceeded",
  "limit": "teachers",          // which limit was hit
  "current": 5,
  "max": 3,
  "upgrade_url": "/app/settings/billing"
}
```

`402 Payment Required` is reserved by Stripe and most clients don't have handling for it. `403` with a typed error body is the convention used by Stripe, GitHub, and most modern SaaS APIs.

### Audit log retention cron

`DELETE FROM audit_log WHERE (school_id, created_at) IN (
  SELECT a.school_id, a.created_at
  FROM audit_log a
  JOIN schools s ON a.school_id = s.id
  JOIN plan_limits pl ON s.plan = pl.plan
  WHERE a.created_at < now() - (pl.audit_retention_days * interval '1 day')
);`

This SQL is checked into `db/cron/audit-retention.sql` and run nightly via pg_cron (extension, included in postgres:16-alpine).

### Stripe webhook handler

Single endpoint at `https://edusupervise.ashbi.ca/api/billing/webhook` (RR7 resource route). Stripe dashboard URL is the same — the `(future) api.edusupervise.ashbi.ca` alias is not added in Tier 1.

Signature verified with `STRIPE_WEBHOOK_SECRET`. Idempotent via the `stripe_events` table:

```ts
await db.transaction(async (tx) => {
  // INSERT throws on UNIQUE conflict — that's the dedup signal
  await tx.insert(stripeEvents).values({ id: event.id, type: event.type, payload: event });
  // Apply state change
  await applyStripeEvent(tx, event);
});
```

If the transaction rolls back, the dedup record is also rolled back, so Stripe's retry processes cleanly.

## 7. API surface

All endpoints are RR7 actions or resource routes. All mutations require CSRF token. All responses are JSON.

### Auth

```
POST   /auth/signup                  create school + first admin
POST   /auth/login                   email + password
POST   /auth/logout
POST   /auth/forgot                  request reset link
POST   /auth/reset                   { token, newPassword }
POST   /auth/magic                   { token }                  ← POST, not GET
GET    /auth/oauth/google            start Google OAuth
GET    /auth/oauth/microsoft         start Microsoft OAuth
POST   /auth/verify-email            { token }
POST   /auth/verify-phone            request SMS code
POST   /auth/verify-phone/confirm    { code }
GET    /api/me                       current user + school
```

### School

```
GET    /api/school                              current school
PATCH  /api/school                              name, timezone, cycle_days, accent_color (admin)
POST   /api/school/logo                         multipart upload (admin)
POST   /api/school/school-year                  rollover to new school year (admin)
```

### Cycle calendar

```
GET    /api/cycle-calendar?start=&end=
POST   /api/cycle-calendar/bulk                 admin — CSV upload
PATCH  /api/cycle-calendar/:date                admin
```

### Duties

```
GET    /api/duties?cycle_day=&is_active=
POST   /api/duties                              admin
PATCH  /api/duties/:id                          admin
DELETE /api/duties/:id                          admin (soft)
```

### Assignments

```
GET    /api/assignments?user_id=&duty_id=&from=&to=
POST   /api/assignments                         admin (validates dates against school year)
PATCH  /api/assignments/:id                     admin
DELETE /api/assignments/:id                     admin
```

### Reminders

```
GET    /api/reminders?assignment_id=
POST   /api/reminders                           admin or owning teacher
PATCH  /api/reminders/:id
DELETE /api/reminders/:id
```

### Users (school admin only)

```
GET    /api/users                               list teachers
POST   /api/users                               manual create (no invite required; admin sets initial password or invite email)
POST   /api/users/invite                        invite by email (better-auth handles accept flow)
PATCH  /api/users/:id                           update role / active
DELETE /api/users/:id                           deactivate
```

### Reports (school admin only)

```
GET    /api/reports/hours?from=&to=&user_id=
GET    /api/reports/coverage?from=&to=
```

### Calendar feed

```
GET    /api/calendar.ics?token=                 per-user feed (token in URL is fine; token is opaque random)
POST   /api/calendar-feed/rotate                rotate the per-user calendar feed token
```

### Notifications

```
GET    /api/notifications                       list in-app notifications
PATCH  /api/notifications/:id                   mark read
```

### Billing

```
POST   /api/billing/checkout                    create Stripe Checkout session
POST   /api/billing/portal                      redirect to Stripe Customer Portal
POST   /api/billing/webhook                     Stripe webhook (no CSRF, signature verified, idempotent)
GET    /api/billing/invoices                    list invoices
GET    /api/billing/audit-export.csv            one-shot CSV download (Tier 1, for downgrade grace)
```

### Audit

```
GET    /api/audit?from=&to=&user_id=&action=    admin only
```

### System

```
GET    /api/health                              health check (no auth)
POST   /api/uploads/csv-roster                  admin — bulk teacher import
```

## 8. Frontend routes

React Router 7 file-based routes.

### Public

| Path | Component | Notes |
|------|-----------|-------|
| `/` | Landing | Marketing page, sign up CTA |
| `/login` | Login | Email/password + magic link + OAuth |
| `/signup` | Signup | School self-signup, plan picker |
| `/forgot` | ForgotPassword | Email entry |
| `/reset` | ResetPassword | Form submits token + new password |
| `/auth/magic` | MagicLinkConsume | Form submits token |
| `/verify-email` | VerifyEmail | Form submits token |
| `/verify-phone` | VerifyPhone | SMS code entry |
| `/legal/privacy` | Privacy | Static page |
| `/legal/terms` | Terms | Static page |

### Authenticated — shared shell

All routes below require `<RequireAuth>`. Layout is `app/routes/_app.tsx`.

| Path | Component | Roles | Notes |
|------|-----------|-------|-------|
| `/app` | Dashboard | all | Today's duties + this week + upcoming reminders |
| `/app/calendar` | Calendar | all | Month grid with cycle overlay |
| `/app/calendar/week/:date` | WeekView | all | Detailed week view |
| `/app/duties` | DutiesList | all | Filter by cycle_day, is_active |
| `/app/duties/new` | DutyForm | admin | Create |
| `/app/duties/:id` | DutyDetail | all | View + edit (admin) |
| `/app/duties/:id/assignments` | AssignmentForm | admin | Assign teachers |
| `/app/assignments` | MyAssignments | all | Teacher sees own; admin sees all |
| `/app/reminders` | RemindersList | all | By assignment |
| `/app/reminders/:id/edit` | ReminderForm | owner/admin | Edit |
| `/app/teachers` | TeachersList | admin | Roster |
| `/app/teachers/invite` | InviteTeacher | admin | Send invite |
| `/app/teachers/new` | NewTeacher | admin | Manual create |
| `/app/teachers/import` | RosterImport | admin | CSV upload |
| `/app/reports` | Reports | admin | Hours + coverage |
| `/app/settings` | Settings | admin | School config, branding, plan |
| `/app/settings/branding` | BrandingForm | admin | Logo + accent color |
| `/app/settings/school-year` | SchoolYearRollover | admin | Year transition |
| `/app/settings/audit` | AuditLog | admin | Paginated |
| `/app/settings/billing` | Billing | admin | Stripe Portal, invoices, downgrade banner |
| `/app/settings/calendar-feed` | CalendarFeed | all | Per-user .ics URL with token |
| `/app/profile` | Profile | all | Name, phone, password change |
| `/app/notifications` | Notifications | all | In-app notifications |

### Layout

```
+-------------------------+----------------------------------+
| Sidebar                 | Topbar (school name, user, bell) |
| - Dashboard             +----------------------------------+
| - Calendar              | Main content                     |
| - Duties                |                                  |
| - Assignments           |                                  |
| - Reminders             |                                  |
| - Teachers (admin)      |                                  |
| - Reports (admin)       |                                  |
| - Settings (admin)      |                                  |
+-------------------------+----------------------------------+
```

Sidebar collapses on mobile. Topbar collapses to hamburger.

## 9. Component structure

```
app/
├── routes/                          # file-based routes
├── components/
│   ├── shell/
│   │   ├── AppShell.tsx
│   │   ├── Sidebar.tsx
│   │   ├── Topbar.tsx
│   │   ├── NotificationBell.tsx
│   │   ├── MobileNav.tsx
│   │   └── DowngradeBanner.tsx       # shown when plan_downgrade_pending_to set
│   ├── duties/
│   ├── calendar/
│   ├── reminders/
│   ├── teachers/
│   │   ├── TeacherList.tsx
│   │   ├── InviteForm.tsx
│   │   ├── NewTeacherForm.tsx        # manual create
│   │   └── RosterImport.tsx
│   ├── ui/
│   ├── billing/
│   │   ├── PlanCard.tsx
│   │   ├── UpgradeBanner.tsx
│   │   ├── DowngradeGraceBanner.tsx
│   │   └── InvoiceList.tsx
│   ├── settings/
│   │   ├── BrandingForm.tsx
│   │   ├── CycleCalendarForm.tsx
│   │   ├── SchoolYearRollover.tsx
│   │   └── AuditExportButton.tsx
│   └── auth/
│       ├── LoginForm.tsx
│       ├── SignupForm.tsx
│       ├── MagicLinkForm.tsx
│       └── OAuthButtons.tsx
├── lib/
│   ├── api.ts                       # fetch wrapper with CSRF + error normalization
│   ├── auth.ts                      # useAuth hook
│   ├── csrf.ts                      # read CSRF cookie, attach header
│   ├── format.ts                    # date/time/cycle helpers
│   ├── errors.ts                    # toast + error boundary
│   └── theme.ts                     # per-school theme application
├── schemas/                         # Zod (shared)
├── styles/
└── root.tsx

server/                              # server-only code (RR7 loaders/actions)
├── auth.server.ts
├── db.server.ts                     # Drizzle + RLS-aware helper
├── queue.server.ts                  # outbox enqueue + BullMQ producer
├── billing.server.ts                # Stripe webhook handlers
├── email.server.ts                  # Resend client + react-email templates
├── sms.server.ts                    # Twilio client
├── audit.server.ts                  # audit log writer
└── csrf.server.ts                   # CSRF validation

worker/
├── index.ts                         # Worker entrypoint
├── heartbeat.ts                     # writes worker_heartbeats every 30s
└── jobs/
    ├── reminders.ts                 # dispatch + retry
    └── outbox-flush.ts              # reads outbox, enqueues to BullMQ

db/
├── schema.ts                        # Drizzle schema mirror of SQL
├── migrations/                      # generated SQL
├── seed.ts
└── cron/
    └── audit-retention.sql          # nightly audit log cleanup

tests/
├── unit/
├── integration/
└── e2e/

docker/
├── Dockerfile.web
├── Dockerfile.worker
└── docker-compose.yml
```

## 10. Reminder worker

**Process:** Separate Node container, runs BullMQ worker. Connects to Postgres as `edusupervise_system` (for `audit_log`, `worker_heartbeats`, `reminder_log` writes) — but always sets `SET LOCAL app.school_id` defensively, matching the runtime path.

**Queue:** `reminders` (Redis-backed).

**Job types:**
- `reminder.dispatch` — fires a reminder to one channel
- `reminder.replan` — recompute and re-enqueue all reminders for a duty_assignment (on schedule change)

**Job payload schema** (Zod, validated on enqueue AND on consume):

```ts
const ReminderJob = z.object({
  schoolId: z.string().uuid(),
  reminderId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  userId: z.string().uuid(),
  channel: z.enum(['email', 'sms']),
  scheduledFor: z.string().datetime(),  // ISO8601 UTC
});
```

If validation fails on consume, the job is moved to BullMQ's failed set with `error: 'invalid_payload'` and an `audit_log` row is written via system role.

**Scheduling:** when a reminder is created, the server computes the next `dispatch_at` based on the duty's next occurrence (in school timezone) and the reminder's `minutes_before`. Job is added to BullMQ with `delay` set to `dispatch_at - now`. Updates to a duty's time or a teacher's assignment trigger `reminder.replan`.

**Retry policy:** on send failure, BullMQ retries with exponential backoff: 1m, 5m, 30m, 2h, 12h. After 5 failed attempts, mark `reminder_log.status = 'failed'`, write `audit_log` with `action = 'reminder.failed'`, surface to admin via in-app notification.

**Idempotency:** `reminder_log` has `UNIQUE(reminder_id, scheduled_for, channel)`. Concurrent dispatches dedupe.

**Concurrency:** 5 workers per container. Horizontally scaleable.

**Logging:** pino JSON to stdout, with `workerId`, `schoolId`, `jobId`, `attempt`, `status`.

**Timezone handling:** all times stored as `TIMESTAMPTZ` (UTC). Worker computes `dispatch_at` by converting the duty's local start_time (in school timezone) to UTC using `Intl.DateTimeFormat` with the school's IANA timezone string.

**Heartbeat:** worker writes a row to `worker_heartbeats` every 30s via `INSERT ... ON CONFLICT (worker_id) DO UPDATE SET last_beat = now(), jobs_completed = worker_heartbeats.jobs_completed + EXCLUDED.jobs_completed`. `/api/health` checks freshness — if any worker hasn't beat in 90s, health returns `degraded`.

## 11. Theming

Each school has `logo_url` and `accent_color`. On every authenticated request, the server loader reads these and passes to the client. Client applies:

```tsx
<html style={{ '--accent': school.accent_color }}>
```

Tailwind config reads `--accent` for primary buttons, links, focus rings.

Logo appears in:
- Topbar (left, 32px tall)
- Login page (centered, 64px)
- Email template header (160px)

Logo upload: admin uploads via `POST /api/school/logo` (multipart). Image stored at `/data/uploads/{school_id}/logo-{timestamp}.png`, served via `/uploads/:school_id/:filename` with proper auth check (returns 403 if requester's `school_id` doesn't match path).

## 12. Audit log

Every state-changing action writes an `audit_log` row in the same transaction as the mutation. For web-initiated actions: the runtime role writes the row (RLS ensures correct `school_id`). For system-initiated actions (webhook, worker): the system role writes with explicit `school_id`.

Captured:
- `user_id` (from session, or NULL for system)
- `action` (e.g. `duty.create`, `reminder.toggle`, `auth.login.failed`)
- `target_type` + `target_id` (the affected row)
- `metadata` JSONB with before/after for updates, full payload for creates
- `ip_address` (from request, NULL for system)
- `user_agent` (from request, NULL for system)

Retention per `plan_limits` (see Section 6 audit retention cron).

Admin can view at `/app/settings/audit` with filters (date range, user, action type). During downgrade grace, an "Export CSV" button is rendered.

## 13. Deployment

### Resource sizing

**Minimum for first customer (1-3 schools):** 4 vCPU / 8 GB RAM / 80 GB NVMe.
**Recommended at 20+ schools:** 8 vCPU / 16 GB RAM / 200 GB NVMe.
**Postgres growth:** ~1 GB per 100 active schools per school year (audit log dominates).

Container `mem_limit` and `cpus` (in compose):

```yaml
postgres: mem_limit: 4g, cpus: '2.0'
redis:    mem_limit: 512m, cpus: '0.5'
web:      mem_limit: 1.5g, cpus: '1.0'
worker:   mem_limit: 1g, cpus: '1.0'
```

### Postgres tuning (override via `command:` in compose)

For 8 GB host:
```
shared_buffers = 1GB
work_mem = 16MB
maintenance_work_mem = 256MB
effective_cache_size = 3GB
max_connections = 100
```

Stored in `/data/postgres/postgresql.conf` override.

### Docker compose

```yaml
# docker/docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: edusupervise_owner
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      POSTGRES_DB: edusupervise
      POSTGRES_INITDB_ARGS: "--auth-host=md5"
    volumes:
      - /data/postgres:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d   # creates roles, runs schema, seeds
    mem_limit: 4g
    cpus: '2.0'
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U edusupervise_owner"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - /data/redis:/data
    mem_limit: 512m
    cpus: '0.5'
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  web:
    build:
      context: ..
      dockerfile: docker/Dockerfile.web
    restart: unless-stopped
    env_file: /root/edusupervise-secrets/.env
    environment:
      DATABASE_URL: postgres://edusupervise_runtime:...@postgres:5432/edusupervise
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    mem_limit: 1.5g
    cpus: '1.0'
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.edusupervise.rule=Host(`edusupervise.ashbi.ca`)"
      - "traefik.http.routers.edusupervise.entrypoints=websecure"
      - "traefik.http.routers.edusupervise.tls.certresolver=letsencrypt"
      - "traefik.http.services.edusupervise.loadbalancer.server.port=3000"

  worker:
    build:
      context: ..
      dockerfile: docker/Dockerfile.worker
    restart: unless-stopped
    env_file: /root/edusupervise-secrets/.env
    environment:
      DATABASE_URL: postgres://edusupervise_system:...@postgres:5432/edusupervise
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    mem_limit: 1g
    cpus: '1.0'
```

The `db/init/` directory contains:
- `01-roles.sql` — creates `edusupervise_runtime`, `edusupervise_system` with appropriate grants and `BYPASSRLS`
- `02-schema.sql` — runs the schema from Section 4
- `03-seed.sql` — seeds `plan_limits` and creates a demo school

`POSTGRES_USER` is `edusupervise_owner` (the role that owns tables). The web container connects as `edusupervise_runtime` (no ownership, no bypass — `FORCE RLS` applies). The worker connects as `edusupervise_system` (`BYPASSRLS`) but explicitly sets `app.school_id` per job for clarity and matching semantics.

### Secrets layout

`/root/edusupervise-secrets/.env`:

```
# Database
DATABASE_URL=postgres://edusupervise_runtime:...@postgres:5432/edusupervise
WORKER_DATABASE_URL=postgres://edusupervise_system:...@postgres:5432/edusupervise

# Cache
REDIS_URL=redis://redis:6379

# Auth
SESSION_SECRET=...
BETTER_AUTH_SECRET=...

# Email
RESEND_API_KEY=...
RESEND_FROM_EMAIL=noreply@edusupervise.ashbi.ca

# SMS
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...

# Billing
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_SCHOOL=price_...

# App
APP_URL=https://edusupervise.ashbi.ca
NODE_ENV=production
LOG_LEVEL=info
```

### Backup

Cron at `/etc/cron.d/edusupervise-backup`:

```
0 3 * * * /opt/edusupervise/backup.sh >> /var/log/edusupervise-backup.log 2>&1
```

`backup.sh`:
1. `pg_dump -Fc edusupervise > /data/backups/edusupervise-$(date +%F).dump`
2. Rsync to offsite (Cameron picks target — Backblaze B2 or a second VPS)
3. Retain last 30 daily + 12 monthly

Restore procedure documented in `docs/runbooks/restore.md`.

### Health

`GET /api/health` returns:
```json
{
  "status": "ok" | "degraded" | "down",
  "db": "ok",
  "redis": "ok",
  "workers": [{ "id": "...", "last_beat": "..." }],
  "uptime_s": 12345
}
```

Traefik health check: `/api/health` every 30s. Mark unhealthy if response is not 200.

### Stripe webhook URL

Stripe dashboard is configured with `https://edusupervise.ashbi.ca/api/billing/webhook`. The `api.edusupervise.ashbi.ca` alias is NOT added in Tier 1 (everything lives under the same host). If/when a CDN or rate-limiter sits in front of `/api/*` in a future tier, the alias is added then — and the Stripe URL is updated at that point with zero-downtime.

## 14. Testing

### Unit (Vitest)

- All pure functions in `app/lib/` and `server/`
- All Zod schemas (round-trip: valid + invalid)
- All React components with `@testing-library/react`
- Coverage target: 70% on `app/lib/` and `server/`, 50% on `app/components/`

### Integration (Vitest + supertest)

- API endpoints with real Postgres (test container) + Redis (test container)
- Auth flows (signup, login, magic link, OAuth mock, password reset, phone verification)
- **RLS enforcement**: user from school A cannot read/write school B's rows on every tenant table
- **CSRF**: cross-origin form POST returns 403
- **Plan limits**: enforcement on mutation returns 403 with correct body shape
- **BullMQ job processing**: worker processes happy path, retries on failure, fails after 5 attempts
- **Worker RLS**: worker writes `reminder_log` for school A; school B user cannot read it
- **Worker job validation**: job with missing `schoolId` is rejected before DB write
- **Multi-school concurrent dispatch**: two jobs for different schools from one worker write to correct `school_id`
- **Stripe webhook idempotency**: same `event.id` fired twice results in one state change
- **Plan downgrade grace**: school downgrades Pro→Free, retention held for 7 days, audit export available
- **CSV roster import**: valid CSV imports; invalid rows reported with line numbers; duplicate email handling

### E2E (Playwright)

- Smoke: signup → create duty → assign teacher → create reminder → verify reminder_log → email received
- Login + logout (all 3 methods)
- Cycle calendar admin CRUD
- Stripe checkout (test mode, mocked webhook)
- Mobile viewport: dashboard, calendar, duty detail

### What we DON'T test

- Visual regression (manual)
- Stripe webhook live (test mode only)
- Twilio/Resend live (test mode + mock for unit)

## 15. Out of scope — Tier 2 roadmap

These get their own focused spec docs once Tier 1 ships.

- **Substitute workflows** — substitutes self-signup via invite link, browse open assignments, accept/decline
- **Push notifications** — Web Push API for in-browser notifications
- **Reports v2** — hours/week per teacher, coverage gaps, equity report (avg duty load distribution)
- **Calendar exports v2** — per-user .ics feed (already exists in Tier 1; v2 adds Google Calendar two-way sync)
- **API keys + webhooks** — partner integrations (HR systems, SIS)
- **i18n** — en + fr (Canada-first), es, with full date/time localization
- **Self-serve audit export** — admin can export anytime, not just during downgrade grace
- **Tenant data isolation test suite** — automated RLS contract test that runs in CI on every migration

## 16. Out of scope — Tier 3 backlog

- Native mobile apps (React Native + Expo)
- District-level multi-tenancy
- AI-assisted duty scheduling
- Parent / student portal
- Public API + Zapier integration
- Self-hosted single-tenant install
- White-label / reseller program

## 17. Open questions

1. **School-year rollover.** Defined as a multi-step admin workflow at `/app/settings/school-year`: (a) confirm new `school_year_start` and `school_year_end`, (b) bulk-insert `cycle_calendar` rows for the upcoming year, (c) prompt: "Copy open-ended assignments forward to new year with `start_date = new school_year_start`?" (d) commit. Open question: should step (c) be the default or opt-in? Defaulting to opt-in (admin explicitly clicks "copy forward") to avoid silent data duplication.
2. **CSV roster import column mapping.** Need a stable schema. Decision: `email,name,role,phone` where `role` defaults to `teacher` and is one of `school_admin|teacher|substitute`, `phone` is optional. Invalid rows reported with line numbers, partial import allowed.
3. **Reminder timezone display.** Reminder email body says "in 15 minutes" — but the duty is in school-local time. Decision: include both: "Your duty at Main Entrance starts at 8:30 AM (school time, America/Toronto) — 15 minutes from now."
4. **Audit log pagination default.** Default 50 rows, max 500 per page. Admin can export CSV for the whole window.
5. **Demo mode for screenshots / portfolio.** The seed script creates one school with two teachers and a populated schedule — usable for portfolio screenshots without touching real data.

## 18. Execution plan

Once this spec is approved, hand off to writing-plans skill which produces a per-file implementation plan. Then mavis-team plan kicks off parallel agents:

| Agent | Scope | Estimated |
|-------|-------|-----------|
| `infra-foundation` | docker-compose, Traefik snippet, Postgres init, three roles, secrets directory layout | 3 days |
| `db-schema` | Drizzle schema, migrations, seed, plan_limits, audit-retention cron | 4 days |
| `auth-and-rls` | better-auth integration, sessions, CSRF, password reset, magic link, OAuth, RLS-aware Drizzle wrapper, integration tests for RLS | 1 week |
| `billing` | Stripe products, checkout, webhooks, stripe_events idempotency, plan enforcement, downgrade grace flow | 1 week |
| `worker` | BullMQ producer (outbox flusher), worker process, reminder dispatch, retry, heartbeat, integration tests for worker RLS | 1 week |
| `frontend-shell` | RR7 setup, app shell, sidebar, topbar, theming, layout, auth flow UI | 4 days |
| `frontend-duties-calendar` | Duties CRUD, assignments, cycle calendar admin, week/month views | 1.5 weeks |
| `frontend-reminders` | Reminder list/form/log, per-teacher settings, in-app notifications | 5 days |
| `frontend-admin` | Teachers + reports + audit + settings + branding + school-year rollover | 1.5 weeks |
| `test-suite` | Vitest unit + supertest integration (RLS, CSRF, plan limits, idempotency) + Playwright e2e | ongoing |

Sequencing:
1. **Week 1:** `infra-foundation` + `db-schema` finish. Postgres is up, schema migrated, seed runs.
2. **Week 2:** `auth-and-rls` finishes. RLS is verified; integration tests prove school A cannot see school B.
3. **Weeks 3-6:** Everything else runs in parallel. Dependencies: `worker` and `billing` need auth-and-rls done; frontend needs auth-and-rls done.
4. **Week 6:** All agents report back, integration testing, deploy to VPS, smoke test on production.

## 19. Acceptance criteria for "Tier 1 done"

- [ ] All 19 sections above have shipped code, not just docs
- [ ] Three Postgres roles exist with documented grants; `FORCE ROW LEVEL SECURITY` on every tenant table
- [ ] Integration test: user from school A cannot read or write any row in school B's data on every tenant table
- [ ] Integration test: worker job with missing `schoolId` is rejected before any DB write
- [ ] Integration test: Stripe webhook fired twice with same `event.id` results in exactly one state change
- [ ] Integration test: CSRF rejects cross-origin POST
- [ ] Integration test: plan limit hit returns 403 with `plan_limit_exceeded` body shape
- [ ] Integration test: Pro→Free downgrade sets `plan_downgrade_pending_to`, exports audit log available, retention held for 7 days
- [ ] `pnpm test` passes with ≥70% coverage on `lib/` and `server/`
- [ ] `pnpm test:e2e` passes on the smoke scenario
- [ ] Deployed to vps.ashbi.ca, accessible at https://edusupervise.ashbi.ca
- [ ] Smoke test on production: signup → assign duty → create reminder → receive email
- [ ] Audit log shows every action in the smoke flow
- [ ] Stripe test-mode checkout upgrades a trial school to Pro
- [ ] Backups verified: dump a fresh DB, restore to a clean Postgres, login works
- [ ] Heartbeat table populated by worker; `/api/health` reports `degraded` when worker is killed
- [ ] No TODO/FIXME in shipped Tier 1 code
- [ ] Cameron does final demo and approves ship

---

**Next step:** Spec review loop iteration 2. Then user reviews the written spec. Then hand off to writing-plans skill. Then mavis-team plan executes.
