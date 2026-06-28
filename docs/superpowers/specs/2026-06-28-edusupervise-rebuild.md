# EduSupervise Rebuild — Design Spec

**Date:** 2026-06-28
**Status:** Draft, awaiting review
**Author:** Mavis (orchestrator)
**Decider:** Cameron Ashley
**Target ship:** Tier 1 in 4-6 weeks, Tier 2 in weeks 6-10, Tier 3 in months 3-6

## 1. Overview

EduSupervise is a multi-tenant SaaS that lets K-12 schools schedule teacher supervision duties (before/after school, recess, lunch, bus dismissal) on a recurring cycle, then automatically reminds the assigned teachers by email and SMS.

**Single deployment = one school per database instance.** Multi-school SaaS (district-level tenancy) lives in Tier 3. Each Tier 1 ship is a deployable product one school can use end-to-end.

### Success criteria for Tier 1

1. A school admin can self-signup, get a 30-day free trial, and onboard teachers via CSV or manual entry.
2. The admin can define the school's cycle calendar (5-day, 6-day, or custom) and mark non-school days.
3. The admin can CRUD duties (time, location, duration, equipment needed) and assign teachers to them with date ranges.
4. Each teacher can log in, see their schedule for any week, and configure reminders (X minutes before, with email and/or SMS channels).
5. Reminders fire on schedule via the BullMQ worker. Each send is logged in `reminder_log` and visible to the admin.
6. The admin can view an audit log of every state change.
7. The admin can upgrade from free to a paid Stripe plan; the system enforces plan limits.
8. Each school's branding (logo, accent color) appears in their UI; data is isolated from other schools by Postgres RLS.
9. End-to-end smoke test (signup → assign duty → create reminder → receive email) passes on a fresh VPS deploy.

### Non-goals (explicit)

- Native mobile apps (Tier 3)
- District-level multi-tenancy (Tier 3)
- Parent / student portal (Tier 3)
- AI-assisted duty scheduling (Tier 3)
- Real-time collaborative editing
- Self-hosted single-tenant install (Tier 3 — for now, all tenants share the SaaS)

## 2. Architecture

```
vps.ashbi.ca (187.77.26.99)
└── Traefik v3.2 (existing)
    ├── edusupervise.ashbi.ca → web container (port 3000, internal only)
    └── (future) api.edusupervise.ashbi.ca → same web container (/api/* alias)

Containers (docker compose):
├── web        React Router 7 SSR + API handlers, port 3000 internal
├── worker     BullMQ worker, no public port
├── postgres   PostgreSQL 16, port 5432 internal only
└── redis      Redis 7, port 6379 internal only

Volumes:
├── /data/postgres         pgdata (WAL + base)
├── /data/redis            appendonly.aof
└── /data/backups          nightly pg_dump + WAL archive

Secrets:
└── /root/edusupervise-secrets/.env   SESSION_SECRET, RESEND_API_KEY,
                                       TWILIO_AUTH_TOKEN, STRIPE_SECRET_KEY,
                                       STRIPE_WEBHOOK_SECRET, DATABASE_URL,
                                       REDIS_URL, BETTER_AUTH_SECRET
```

### Request flow (typical mutation)

1. Browser POSTs form to React Router action at `/admin/duties/new`
2. Action validates with Zod schema from `app/schemas/`
3. Action opens Drizzle transaction
4. Action sets `app.school_id` Postgres session var from request context
5. RLS policies ensure the duty is written with the right `school_id`
6. Mutation runs; audit_log row written in same transaction
7. Transaction commits
8. If the mutation affects reminders, enqueue a BullMQ job in the same transaction (transactional outbox pattern)
9. BullMQ worker picks up the job and dispatches at scheduled time

### Request flow (reminder dispatch)

1. BullMQ worker pulls a `reminder.dispatch` job at scheduled time
2. Worker loads duty_assignment, user contact info, school branding
3. Worker checks `app.school_id` is set (defensive — workers shouldn't write to multi-tenant tables anyway)
4. Worker calls Resend (email) and/or Twilio (SMS) API
5. On success: writes `reminder_log` row with status `sent`
6. On failure: BullMQ retries with exponential backoff (1m, 5m, 30m, 2h, 12h), then writes `reminder_log` with status `failed` and surfaces to admin

## 3. Stack (pinned)

### Runtime

| Package | Version | Why |
|---------|---------|-----|
| Node.js | 20 LTS | Stable, ESM, native fetch |
| TypeScript | ^5.6.0 | Strict, no any |
| pnpm | ^9.0 | Workspace-aware, fast |

### Web framework

| Package | Version | Why |
|---------|---------|-----|
| react-router | ^7.1.0 | Remix successor; SSR + loaders + actions |
| @react-router/node | ^7.1.0 | Node adapter |
| @react-router/serve | ^7.1.0 | Production server |
| react | ^18.3.0 | Stable |
| react-dom | ^18.3.0 | Stable |

### UI

| Package | Version | Why |
|---------|---------|-----|
| tailwindcss | ^3.4 | Utility CSS, matches existing visual vocabulary |
| @radix-ui/react-* | latest | Accessible primitives (Dialog, Select, Toast, Popover, etc.) |
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
| drizzle-orm | ^0.36 | TypeScript-first ORM |
| drizzle-kit | ^0.28 | Migration generator |
| @electric-sql/pglite | ^0.2 | Optional: in-memory Postgres for tests |

### Cache + queue

| Package | Version | Why |
|---------|---------|-----|
| ioredis | ^5.4 | Redis client |
| bullmq | ^5.21 | Job queue with retry/backoff |

### Auth

| Package | Version | Why |
|---------|---------|-----|
| better-auth | ^1.0 | Email/password + magic link + OAuth (Google, Microsoft) in one lib |

### Billing

| Package | Version | Why |
|---------|---------|-----|
| stripe | ^17.0 | Server SDK |
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
| express | ^4.21 | Minimal HTTP wrapper for API routes that don't fit RR7 actions |
| helmet | ^8.0 | Security headers |
| pino | ^9.5 | Structured JSON logs |
| pino-http | ^10.3 | Request logging middleware |
| zod | (shared) | Validation |

### Testing

| Package | Version | Why |
|---------|---------|-----|
| vitest | ^2.1 | Fast unit tests |
| @testing-library/react | ^16.0 | Component tests |
| @testing-library/user-event | ^14.5 | Interaction simulation |
| @playwright/test | ^1.48 | E2E |
| supertest | ^7.0 | API integration tests |

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

All tables live in the `public` schema. Every tenant-owned table has `school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE` and an RLS policy restricting reads/writes to the current `app.school_id`.

```sql
-- =========================================
-- Tenancy
-- =========================================

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL, -- URL-safe identifier, e.g. "maple-elementary"
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  cycle_days INTEGER NOT NULL DEFAULT 5 CHECK (cycle_days BETWEEN 1 AND 10),
  school_year_start DATE NOT NULL, -- first day of school year (anchor for cycle)
  plan TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'free', 'pro', 'school')),
  trial_ends_at TIMESTAMPTZ,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  logo_url TEXT,
  accent_color TEXT DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  password_hash TEXT, -- nullable for OAuth-only users
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

-- Sessions table is owned by better-auth; we don't define it here.

-- =========================================
-- Cycle calendar
-- =========================================

CREATE TABLE cycle_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  cycle_day INTEGER, -- 1..cycle_days; null = non-school day
  is_school_day BOOLEAN NOT NULL DEFAULT true,
  note TEXT, -- e.g. "PD day", "snow day"
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
  start_time TIME NOT NULL, -- local time in school timezone
  end_time TIME NOT NULL,
  location TEXT NOT NULL,
  description TEXT,
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
  end_date DATE, -- null = open-ended
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX idx_assignments_school_user ON duty_assignments(school_id, user_id);
CREATE INDEX idx_assignments_school_duty ON duty_assignments(school_id, duty_id);

-- =========================================
-- Reminders
-- =========================================

CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES duty_assignments(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL CHECK (minutes_before >= 0 AND minutes_before <= 10080), -- max 7 days
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_sms BOOLEAN NOT NULL DEFAULT false,
  custom_message TEXT,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reminder_log_school_status ON reminder_log(school_id, status);
CREATE INDEX idx_reminder_log_assignment ON reminder_log(assignment_id);

-- =========================================
-- Audit log
-- =========================================

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id), -- nullable for system actions
  action TEXT NOT NULL, -- e.g. 'duty.create', 'reminder.update', 'auth.login'
  target_type TEXT, -- e.g. 'duty', 'reminder', 'user'
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_school_created ON audit_log(school_id, created_at DESC);
CREATE INDEX idx_audit_target ON audit_log(school_id, target_type, target_id);

-- =========================================
-- Plan enforcement (settings)
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
-- RLS policies (apply to every tenant-owned table)
-- =========================================

-- Helper: a function reads the per-transaction school_id set by the app
CREATE OR REPLACE FUNCTION current_school_id() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Enable RLS on each tenant-owned table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE duties ENABLE ROW LEVEL SECURITY;
ALTER TABLE duty_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Policy template: rows visible only if school_id matches current setting
CREATE POLICY tenant_isolation ON users
  USING (school_id = current_school_id())
  WITH CHECK (school_id = current_school_id());
-- (repeat for each tenant-owned table)

-- Schools table is special: a user can see their own school only
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY school_self ON schools
  USING (id = current_school_id())
  WITH CHECK (id = current_school_id());

-- Audit log: read-only access for school admins; writes happen via service role bypass
-- (Service role uses a separate Postgres user that has BYPASSRLS)
```

### Multi-tenancy propagation

Every request that touches tenant data calls:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.school_id = ${schoolId}`);
  // ... all queries here are RLS-protected
});
```

The `schoolId` comes from the authenticated session. A user cannot access another school's data even if they craft malicious URLs — Postgres enforces the boundary.

## 5. Auth

**Library:** better-auth ^1.0

**Methods supported:**
- Email + password (bcrypt, 12 rounds — better-auth default)
- Magic link via email (passwordless)
- Google OAuth (for school admins who prefer it)
- Microsoft OAuth (for schools on Microsoft 365)

**Sessions:** stored in Postgres via better-auth's session adapter. Cookie config:

```
Name: __Host-edusupervise.session
HttpOnly: true
Secure: true (prod only)
SameSite: Lax
Max-Age: 30 days
Path: /
```

**Password reset:** standard flow. POST `/auth/forgot` sends a signed token (HMAC-SHA256, 1-hour TTL, single-use) via Resend. POST `/auth/reset` validates token, updates password.

**Email verification:** required for teachers; school admins must verify before sending invites. Better-auth handles the verify email flow.

**Phone verification:** for SMS reminders, the teacher must verify their phone via a one-time code sent via Twilio Verify.

**CSRF:** all state-changing requests include a double-submit cookie (`__Host-edusupervise.csrf`). React Router actions read it via `getCsrfToken(request)` helper.

**Rate limits:**
- Login: 5 attempts / 15 min / IP
- Forgot password: 3 / hour / email
- Magic link: 5 / hour / email

## 6. Billing

**Library:** Stripe ^17.0

**Plans:**

| Plan | Price | Teachers | Duties | SMS | Audit retention |
|------|-------|----------|--------|-----|-----------------|
| Trial | Free 30 days | 5 | 20 | No | 14 days |
| Free | $0 forever | 3 | 10 | No | 7 days |
| Pro | $49/mo per school | 50 | 500 | Yes | 90 days |
| School | $199/mo per school | 500 | 5,000 | Yes | 365 days |

**Flow:**

1. School signs up → trial plan, 30 days, full Pro features
2. Trial ends → auto-downgrade to Free (limited features)
3. Admin clicks "Upgrade" → Stripe Checkout (Pro or School)
4. Stripe webhook `checkout.session.completed` → server updates `schools.plan` + `stripe_subscription_id`
5. Stripe webhook `customer.subscription.deleted` → downgrade to Free
6. Stripe webhook `invoice.payment_failed` → mark school `past_due`, show banner, limit after 7 days

**Plan enforcement:** every mutation checks `plan_limits` for the school's current plan. If the limit is hit, return 402 with a clear message + upgrade CTA.

**Webhook handler:** single endpoint at `/api/billing/webhook`. Signature verified with `STRIPE_WEBHOOK_SECRET`. Idempotent on `event.id` to handle retries.

## 7. API surface

All endpoints under `/api/*` (or as React Router actions). All mutations require CSRF token. All responses are JSON.

### Auth

```
POST   /auth/signup                  create school + first admin
POST   /auth/login                   email + password
POST   /auth/logout
POST   /auth/forgot                  request reset link
POST   /auth/reset                   submit new password
GET    /auth/magic/:token            consume magic link
GET    /auth/oauth/google            start Google OAuth
GET    /auth/oauth/microsoft         start Microsoft OAuth
POST   /auth/verify-email/:token     consume verification token
POST   /auth/verify-phone            request SMS code
POST   /auth/verify-phone/confirm    submit SMS code
GET    /api/me                       current user + school
```

### Cycle calendar

```
GET    /api/cycle-calendar?start=&end=    date range
POST   /api/cycle-calendar/bulk           admin — CSV upload
PATCH  /api/cycle-calendar/:date          admin — mark non-school-day or change cycle_day
```

### Duties

```
GET    /api/duties?cycle_day=&is_active=
POST   /api/duties                        admin
PATCH  /api/duties/:id                    admin
DELETE /api/duties/:id                    admin (soft delete, is_active=false)
```

### Assignments

```
GET    /api/assignments?user_id=&duty_id=&from=&to=
POST   /api/assignments                   admin
PATCH  /api/assignments/:id               admin
DELETE /api/assignments/:id               admin
```

### Reminders

```
GET    /api/reminders?assignment_id=
POST   /api/reminders                     admin or owning teacher
PATCH  /api/reminders/:id
DELETE /api/reminders/:id
```

### Users (school admin only)

```
GET    /api/users                         list teachers in school
POST   /api/users/invite                  invite teacher by email
PATCH  /api/users/:id                     update role / active
DELETE /api/users/:id                     deactivate
```

### Reports (school admin only)

```
GET    /api/reports/hours?from=&to=&user_id=
GET    /api/reports/coverage?from=&to=    gaps in coverage
```

### Calendar feed

```
GET    /api/calendar.ics?token=           per-user .ics feed (token in URL)
```

### Billing

```
POST   /api/billing/checkout              create Stripe Checkout session
POST   /api/billing/portal                redirect to Stripe Customer Portal
POST   /api/billing/webhook               Stripe webhook (no CSRF, signature verified)
```

### Audit

```
GET    /api/audit?from=&to=&user_id=&action=
```

### System

```
GET    /api/health                        health check (no auth)
POST   /api/uploads/csv-roster            admin — bulk teacher import
```

## 8. Frontend routes

React Router 7 file-based routes. Each route is a `loader` (server-side data fetch) + default export (React component). Mutations are `action` exports.

### Public

| Path | Component | Notes |
|------|-----------|-------|
| `/` | Landing | Marketing page, sign up CTA |
| `/login` | Login | Email/password + magic link + OAuth |
| `/signup` | Signup | School self-signup, plan picker |
| `/forgot` | ForgotPassword | Email entry |
| `/reset/:token` | ResetPassword | Token + new password |
| `/verify-email/:token` | VerifyEmail | Consumes verification token |
| `/verify-phone` | VerifyPhone | SMS code entry |
| `/legal/privacy` | Privacy | Static page |
| `/legal/terms` | Terms | Static page |

### Authenticated — shared shell

All routes below require `<RequireAuth>`. Layout is `app/routes/_app.tsx` which renders sidebar + topbar + main content.

| Path | Component | Roles | Notes |
|------|-----------|-------|-------|
| `/app` | Dashboard | all | Today's duties + this week + upcoming reminders |
| `/app/calendar` | Calendar | all | Month grid with cycle overlay |
| `/app/calendar/week/:date` | WeekView | all | Detailed week view |
| `/app/duties` | DutiesList | all | Filter by cycle_day, is_active |
| `/app/duties/new` | DutyForm | admin | Create new duty |
| `/app/duties/:id` | DutyDetail | all | View + edit (admin) |
| `/app/duties/:id/assignments` | AssignmentForm | admin | Assign teachers |
| `/app/assignments` | MyAssignments | all | Teacher sees own; admin sees all |
| `/app/reminders` | RemindersList | all | By assignment |
| `/app/reminders/:id/edit` | ReminderForm | owner/admin | Edit |
| `/app/teachers` | TeachersList | admin | Roster |
| `/app/teachers/invite` | InviteTeacher | admin | Send invite |
| `/app/reports` | Reports | admin | Hours + coverage |
| `/app/settings` | Settings | admin | School config, branding, plan |
| `/app/settings/audit` | AuditLog | admin | Paginated audit |
| `/app/settings/billing` | Billing | admin | Stripe Portal, invoices |
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

Sidebar collapses on mobile. Topbar collapses to hamburger. All Radix `<Dialog>` for mobile nav.

## 9. Component structure

```
app/
├── routes/                          # file-based routes (one folder per route)
│   ├── _index.tsx                   # /
│   ├── login.tsx
│   ├── signup.tsx
│   ├── _app.tsx                     # authenticated layout
│   ├── _app._index.tsx              # /app
│   ├── _app.duties._index.tsx       # /app/duties
│   ├── _app.duties.new.tsx
│   ├── _app.duties.$id.tsx
│   └── ...
├── components/
│   ├── shell/
│   │   ├── AppShell.tsx
│   │   ├── Sidebar.tsx
│   │   ├── Topbar.tsx
│   │   ├── NotificationBell.tsx
│   │   └── MobileNav.tsx
│   ├── duties/
│   │   ├── DutyCard.tsx
│   │   ├── DutyForm.tsx
│   │   ├── DutyList.tsx
│   │   └── DutyTable.tsx
│   ├── calendar/
│   │   ├── MonthView.tsx
│   │   ├── WeekView.tsx
│   │   ├── DayCell.tsx
│   │   └── CycleLegend.tsx
│   ├── reminders/
│   │   ├── ReminderList.tsx
│   │   ├── ReminderForm.tsx
│   │   └── ReminderLog.tsx
│   ├── teachers/
│   │   ├── TeacherList.tsx
│   │   ├── InviteForm.tsx
│   │   └── RosterImport.tsx
│   ├── ui/                          # Radix wrappers + shadcn patterns
│   │   ├── Button.tsx
│   │   ├── Dialog.tsx
│   │   ├── Select.tsx
│   │   ├── Input.tsx
│   │   ├── Form.tsx
│   │   ├── Toast.tsx
│   │   ├── Table.tsx
│   │   ├── Tabs.tsx
│   │   ├── Popover.tsx
│   │   └── ...
│   ├── billing/
│   │   ├── PlanCard.tsx
│   │   └── UpgradeBanner.tsx
│   └── settings/
│       ├── BrandingForm.tsx
│       └── CycleCalendarForm.tsx
├── lib/
│   ├── api.ts                       # fetch wrapper with CSRF, error normalization
│   ├── auth.ts                      # client-side useAuth hook
│   ├── format.ts                    # date/time/cycle helpers
│   ├── errors.ts                    # toast + error boundary helpers
│   └── theme.ts                     # per-school theme application
├── schemas/                         # Zod schemas (shared client + server)
│   ├── auth.ts
│   ├── duty.ts
│   ├── assignment.ts
│   ├── reminder.ts
│   ├── user.ts
│   └── school.ts
├── styles/
│   └── app.css                      # Tailwind directives + global
└── root.tsx                         # RR7 root layout
```

## 10. Reminder worker

**Process:** Separate Node container, runs BullMQ worker.

**Queue:** `reminders` (Redis-backed).

**Job types:**
- `reminder.dispatch` — fires a reminder to one channel
- `reminder.replan` — recompute and re-enqueue all reminders for a duty_assignment (on schedule change)

**Scheduling:** when a reminder is created, the server computes the next `dispatch_at` based on the duty's next occurrence and the reminder's `minutes_before`. Job is added to BullMQ with `delay` set to `dispatch_at - now`.

**Retry policy:** on send failure, BullMQ retries with exponential backoff: 1m, 5m, 30m, 2h, 12h. After 5 failed attempts, mark `reminder_log.status = 'failed'` and write to `audit_log`.

**Idempotency:** `reminder_log` has a unique constraint on `(reminder_id, scheduled_for, channel)`. Concurrent dispatches dedupe.

**Concurrency:** 5 workers per container. Horizontally scaleable — just run more worker containers.

**Logging:** pino JSON to stdout. Each job logs:
```json
{
  "jobId": "...",
  "reminderId": "...",
  "userId": "...",
  "channel": "email",
  "attempt": 1,
  "duration_ms": 234,
  "status": "sent",
  "externalId": "resend_..." 
}
```

**Timezone handling:** all times stored in Postgres as `TIMESTAMPTZ` (UTC). Worker computes `dispatch_at` by converting the duty's local start_time (in school timezone) to UTC. School timezone is read from `schools.timezone`.

**Heartbeat:** worker writes a heartbeat row every 30s to a `worker_heartbeats` table. `/api/health` checks freshness — if any worker hasn't beat in 90s, health returns degraded.

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

Logo upload: admin uploads via `/app/settings/branding`, image stored on local filesystem (`/data/uploads/{school_id}/logo.png`), served via `/uploads/:school_id/logo.png` with proper auth check.

## 12. Audit log

Every state-changing action writes an `audit_log` row in the same transaction as the mutation. Captured:

- `user_id` (from session, or null for system actions)
- `action` (e.g. `duty.create`, `reminder.toggle`, `auth.login.failed`)
- `target_type` + `target_id` (the affected row)
- `metadata` JSONB with before/after values for updates, full payload for creates
- `ip_address` (from request)
- `user_agent` (from request)

Retention per plan (see `plan_limits` table). Cron job nightly deletes old rows beyond retention.

Admin can view at `/app/settings/audit` with filters (date range, user, action type).

## 13. Deployment

### Docker compose

```yaml
# docker/docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: edusupervise
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
      POSTGRES_DB: edusupervise
    volumes:
      - /data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U edusupervise"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - /data/redis:/data
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
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
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
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

volumes:
  pgdata:
  redisdata:
```

### Secrets layout

`/root/edusupervise-secrets/.env`:

```
DATABASE_URL=postgres://edusupervise:...@postgres:5432/edusupervise
REDIS_URL=redis://redis:6379
SESSION_SECRET=...
BETTER_AUTH_SECRET=...
RESEND_API_KEY=...
RESEND_FROM_EMAIL=noreply@edusupervise.ashbi.ca
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_SCHOOL=price_...
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
2. Copy to offsite (rsync to a remote or upload to B2/S3 — Cameron picks)
3. Retain last 30 daily + 12 monthly

Restore procedure documented in `docs/runbooks/restore.md` (created during build).

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

## 14. Testing

### Unit (Vitest)

- All pure functions in `app/lib/`
- All Zod schemas (round-trip: valid + invalid inputs)
- All React components with `@testing-library/react`
- Coverage target: 70% on `app/lib/` and `server/`, 50% on `app/components/`

### Integration (Vitest + supertest)

- API endpoints with real Postgres (test container) + Redis (test container)
- Auth flows (signup, login, magic link, OAuth mock, password reset)
- RLS enforcement (verify a user from school A cannot read school B data)
- Plan limits (verify enforcement on mutation)
- BullMQ job processing (test mode, fast retry)

### E2E (Playwright)

- Smoke: signup → create duty → assign teacher → create reminder → verify reminder_log
- Login + logout
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
- **Push notifications** — Web Push API for in-browser notifications when duty is approaching
- **Reports** — hours/week per teacher, coverage gaps, equity report (avg duty load distribution)
- **Calendar exports** — per-user .ics feed, Google Calendar two-way sync (OAuth + webhook)
- **API keys + webhooks** — partner integrations (HR systems, SIS)
- **i18n** — en + fr (Canada-first), es, with full date/time localization

## 16. Out of scope — Tier 3 backlog

- **Native mobile apps** (React Native + Expo)
- **District-level multi-tenancy** (district = parent tenant of schools)
- **AI-assisted duty scheduling** (auto-balance hours, fairness optimization)
- **Parent / student portal** (read-only view of supervision schedule)
- **Public API + Zapier integration**
- **Self-hosted single-tenant install** (Docker Compose install wizard)
- **White-label / reseller program**

## 17. Open questions

1. **Stripe Checkout vs Custom Checkout?** Defaulting to Stripe Checkout (hosted) for v1, custom checkout if conversion drops.
2. **CSV roster import format?** Need to define a stable schema. Decision: `email,name,role,phone` (role defaults to `teacher`, phone optional).
3. **Cron timezone for reminders?** Computed per-school from `schools.timezone`. Documented in `app/lib/format.ts`.
4. **Free plan limits — soft or hard?** Hard — hitting limit returns 402. Decision rationale: clearer UX than partial-success.
5. **Audit log export?** Out of Tier 1 (admin can paginate and screenshot). Tier 2.
6. **Data export for GDPR?** School admin can request export via email in Tier 1; self-serve export is Tier 2.

## 18. Execution plan

Once this spec is approved, hand off to writing-plans skill which produces a per-file implementation plan. Then mavis-team plan kicks off parallel agents:

| Agent | Scope | Estimated |
|-------|-------|-----------|
| `backend-auth` | better-auth + sessions + password reset + OAuth + RLS foundation | 1 week |
| `backend-db` | Drizzle schema + migrations + seed script + plan_limits | 3 days |
| `backend-billing` | Stripe products + checkout + webhooks + plan enforcement | 4 days |
| `backend-worker` | BullMQ + reminder dispatch + retry + heartbeat | 1 week |
| `frontend-shell` | RR7 setup + auth flow + app shell + sidebar/topbar | 4 days |
| `frontend-duties` | Duties CRUD + assignment form + calendar week/month views | 1 week |
| `frontend-reminders` | Reminder list/form/log + per-teacher settings | 3 days |
| `frontend-admin` | Teachers + reports + audit + settings pages | 1 week |
| `devops-deploy` | Dockerfiles + compose + Traefik snippet + secrets + backup | 3 days |
| `test-suite` | Vitest unit + supertest integration + Playwright e2e | ongoing |

Agents work in parallel where dependencies allow. Backend-auth and backend-db finish first; everything else unblocks once RLS + auth are stable.

## 19. Acceptance criteria for "Tier 1 done"

- [ ] All 19 sections above have shipped code, not just docs
- [ ] `pnpm test` passes with ≥70% coverage on lib/server
- [ ] `pnpm test:e2e` passes on the smoke scenario
- [ ] Deployed to vps.ashbi.ca, accessible at https://edusupervise.ashbi.ca
- [ ] Smoke test on production: signup → assign duty → create reminder → receive email
- [ ] Audit log shows every action in the smoke flow
- [ ] Stripe test-mode checkout upgrades a trial school to Pro
- [ ] Backups verified: dump a fresh DB, restore to a clean Postgres, login works
- [ ] No TODO/FIXME in shipped Tier 1 code (defer to Tier 2 docs if needed)
- [ ] Cameron does final demo and approves ship

---

**Next step:** Spec review loop (dispatch `spec-document-reviewer` subagent, iterate up to 3 times). Then user reviews the written spec. Then hand off to writing-plans skill to produce implementation plan. Then mavis-team plan executes.
