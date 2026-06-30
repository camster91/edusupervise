# Public Signup & Demo Mode

**Date:** 2026-06-29
**Status:** Draft → review
**Owner:** Cameron (PM), Mavis (implementer)

## Context

EduSupervise is a duty-coverage app for K-12 schools. Today, the only way to create a teacher account is to manually insert a row in the `users` table — there is no self-serve path. The `signup.tsx` route creates a school + first `school_admin` only; the `onboarding.teacher._index.tsx` route is a post-login welcome page, not a signup. The admin wizard's "Add your teachers" step (step 2) is broken — it asks for a teacher count and says "we'll create placeholder accounts" but does nothing.

This blocks three user segments:

1. **New teachers** who land on the site and want to start using the app today.
2. **Small schools / lone practitioners** (sub teachers, specialists) who don't have an admin to invite them.
3. **Prospective customers** who want to see the product before committing.

This spec replaces the broken `invite-by-email` flow with a public self-serve signup that supports three modes in one `/signup` page, and adds a pre-seeded demo mode with 30-day expiry.

## Goals

- **Public signup**: any visitor can create an account and start using the app within 60 seconds.
- **Three modes** in `/signup`: join an existing school via code, create a lone-teacher school, or start a pre-seeded demo.
- **Demo mode**: 30-day sandbox school with realistic sample data, banner showing days remaining, "Reset demo" re-seeds.
- **Demo expiry**: sandbox becomes read-only (or can be reset/restarted) after 30 days.
- **Schema migrations are backward-compatible** (no data loss on upgrade).

## Non-Goals

- Email verification of new signups (Resend is mocked; no email infra yet).
- Admin ability to ban/approve new teachers.
- Cross-school teacher account (one user = one school).
- Demo data export / import.
- Multi-school admin (district accounts).
- Resend-style passwordless auth (password is required).

## Design

### Database (migration 0006)

**New columns on `schools`:**
- `join_code text NOT NULL UNIQUE` — short, shareable identifier; format `WORD-NN` (e.g. `SUNRISE-43`).
- `demo_expires_at timestamptz` (nullable) — when this school auto-expires from demo mode.
- `demo_seed_variant text` (nullable) — which dataset variant this school was seeded with (`'elementary'` is the only value for v1).

**Schema changes:**
- Extend `pgEnum('plan', ['free', 'school', 'district', 'demo', 'demo_expired'])`.
- The existing `plan='free'` value is reused for both "lone teacher" and "expired demo" depending on the lifecycle state.

**New table `signup_attempts`:**
- `id uuid PK`, `email citext`, `ip_address inet`, `user_agent text`, `mode text` (one of `'join'`, `'solo'`, `'demo'`), `outcome text` (`'success'`, `'invalid_code'`, `'duplicate_email'`, `'rate_limited'`, `'error'`), `created_at timestamptz NOT NULL DEFAULT now()`.
- Purpose: rate-limit per IP + per email, audit trail, future analytics.

**Indexes:**
- `schools(join_code)` UNIQUE btree.
- `signup_attempts(email, created_at DESC)` btree.
- `signup_attempts(ip_address, created_at DESC)` btree.

### School code generation

When a school is created (lone or demo), generate `WORD-NN`:
1. `WORD` = first word of school name, uppercased, alpha-only, truncated to 8 chars. If empty, pick from a built-in wordlist (`AURORA, CEDAR, DELTA, EMBER, FOREST, GLACIER, HARBOR, IRON, JADE, KESTREL, LUNA, MAPLE, NOVA, OAK, PINE, QUARTZ, RIDGE, SUMMIT, TIDE, UMBRA, VALE, WAVE, YEW, ZENITH`).
2. `NN` = 2-digit random number (00–99).
3. On UNIQUE collision, retry up to 100 times. After 100 collisions, fall back to 3 digits (000–999) and retry up to 100 times. After that, throw `SCHOOL_CODE_EXHAUSTED` (caller shows a retry error).

Demo school codes skip the school-name derivation: the seed uses a fixed `WORD` (e.g. `SUNRISE`) and re-tries on collision. This keeps demo school codes predictable for repeated runs (most likely `SUNRISE-43`, falls back to `SUNRISE-44`, etc.).

### Routes

| Method | Path | Purpose | Auth | CSRF |
|--------|------|---------|------|------|
| GET | `/signup` | Three-card signup page (Join / Solo / Demo) | public | n/a |
| POST | `/api/signup/join` | `{name, email, password, schoolCode}` → user joins existing school | public | yes |
| POST | `/api/signup/solo` | `{name, email, password, schoolName}` → new school + school_admin | public | yes |
| POST | `/api/signup/demo` | `{name, email, password}` → pre-seeded demo school | public | yes |
| POST | `/app/api/demo/reset` | Wipe + re-seed current demo school | school_admin, plan='demo' | yes |
| GET | `/app/settings` (existing) | Show school's `join_code` with copy button | school_admin | n/a |

### `/signup` page (UI)

Three cards in a vertical stack on mobile, horizontal on tablet/desktop. Each card has:
- An icon (Users / User / Sparkles from lucide-react).
- A title: "Join a school", "I'm flying solo", "Try the demo".
- A one-sentence description.
- An inline form that expands when the card is clicked (accordion style, only one open at a time).
- A primary button at the bottom of the form: "Join", "Create my school", "Start demo".
- Loading state on the button while submitting.
- Inline error message slot above the button.

The form fields are identical across the three modes:
- Full name (required, 2–80 chars).
- Email (required, valid format, lowercased on submit).
- Password (required, min 8 chars, with show/hide toggle).
- Plus the mode-specific field:
  - **Join**: school code (auto-uppercase, 6–9 chars including hyphen).
  - **Solo**: school name (required, 2–80 chars).
  - **Demo**: (no extra field).

### Server logic

**`/api/signup/join`:**
1. Rate-limit check: max 5 attempts per email per hour, max 20 per IP per hour (read `signup_attempts`).
2. Validate input with zod.
3. Look up `schools` by `join_code` (case-insensitive). If not found → 400 with "School code not recognized" + log attempt with `outcome='invalid_code'`.
4. Check school's `max_teachers` quota. If full → 409 with "School is at capacity. Ask your admin to upgrade or remove a teacher." + log attempt with `outcome='quota_full'`.
5. Create `users` row with `role='teacher'`, `status='active'`, `school_id=existing`, `password_hash=bcrypt(password, cost=12)`.
6. Create session, set session cookie.
7. Log attempt with `outcome='success'`.
8. Redirect to `/onboarding/teacher` (the existing welcome page).

**`/api/signup/solo`:**
1. Rate-limit check (same as above).
2. Validate input.
3. Generate `join_code` (WORD-NN with collision retry).
4. Begin transaction:
   - Insert `schools` row with `plan='free'`, `name=schoolName`, `join_code=...`.
   - Insert `users` row with `role='school_admin'`, `status='active'`, `school_id=newSchool.id`, `password_hash=...`.
5. Commit.
6. Create session, set session cookie.
7. Log attempt with `outcome='success'`.
8. Redirect to `/onboarding/admin` (the existing 4-step wizard).

**`/api/signup/demo`:**
1. Rate-limit check.
2. Validate input.
3. Generate `join_code` (use `SUNRISE` wordlist fallback, retry).
4. Begin transaction:
   - Insert `schools` row with `plan='demo'`, `name='Sunrise Elementary'`, `join_code=...`, `demo_expires_at = now() + 30 days`, `demo_seed_variant='elementary'`.
   - Insert `users` row with `role='school_admin'`, `status='active'`, `password_hash=...`.
   - Call `seedDemoData(schoolId, variant='elementary')` — see below.
5. Commit.
6. Create session, set session cookie.
7. Log attempt with `outcome='success'`.
8. Redirect to `/app/today`.

**`/app/api/demo/reset`:**
1. Auth check: must be `school_admin` and `schools.plan='demo'`.
2. CSRF check.
3. Begin transaction:
   - Delete all tenant-scoped rows for this school (use `withSchoolId` so RLS scopes it): `coverage_events`, `coverage_assignments`, `parent_alerts`, `parent_contacts`, `parent_route_tags`, `duties`, `teachers`, `duty_tags` (any others).
   - Re-call `seedDemoData(schoolId)`.
   - Reset `demo_expires_at = now() + 30 days` (extends the trial).
4. Commit.
5. Redirect to `/app/today` with toast "Demo reset".

### Demo seed data (`seedDemoData`)

A pure function in `apps/web/server/demo-seed.server.ts` that takes a `schoolId` and inserts the deterministic dataset. Idempotent within a transaction (no `IF NOT EXISTS` checks — caller wraps in DELETE+insert).

**School:** `Sunrise Elementary`, 12 teachers total → 5 active teachers in the roster (the rest are "left the school" and not shown).

**Teachers:**
| Name | Grade | Room | Role flags |
|------|-------|------|-----------|
| Ms. Chen | K | 101 | primary |
| Mr. Daniels | 2 | 204 | primary |
| Mrs. Patel | 3 | 305 | primary, currently absent |
| Mr. Okafor | 5 | 502 | primary |
| Ms. Rivera | Music | 110 | specialist |

**Duty slots (cycle day 1, weekday):**
| Period | Slot | Assigned-to |
|--------|------|-------------|
| 11:00–11:30 | Cafeteria lunch A | Mr. Okafor (accepted) |
| 11:30–12:00 | Cafeteria lunch B | unassigned |
| 12:00–12:30 | Recess (north) | Ms. Rivera (accepted) |
| 14:50–15:15 | Bus dismissal | unassigned |

**Active scenario (today, 2026-XX-XX, with a 24h-rng offset baked in so it's always "today"):**
- One `coverage_events` row: `kind='absence'`, `teacher_id=Mr. Patel`, `date=today`, `cycle_day=1`, `status='routed'`.
- One `coverage_assignments` row: routed to `Mr. Okafor` (the next available teacher with the lowest duty load), `status='pending'`.
- One `parent_alerts` row: generated from the assignment, `status='draft'`, message body pre-written.
- One historical `parent_alerts` row from yesterday: `status='sent'`, `parent_contact_id=fakeParent`, message body pre-written, to demonstrate the "Sent alerts" tab.

**Parent contacts:** 2 fake contacts (one for Mr. Patel's class, one for Mr. Okafor's), with names + emails (e.g. `parent.patel@example.com`).

### Banner & expired state

Add a new component `<DemoBanner />` rendered in `_app.tsx` when `plan === 'demo'`. Shows:
- "Demo mode — your school resets in N days, M hours."
- "Reset demo" link → POST `/app/api/demo/reset`.
- "Real signup" link → `/signup` (re-uses the same page for upgrading, but with a "Use existing account" flow TBD; for v1 the link goes to the marketing landing page `/`).

When `plan === 'demo_expired'`, the loader on every `/app/*` route renders an `<ExpiredDemo />` page (full screen, centered) with:
- "Your demo has expired."
- "Restart demo" button → POST `/app/api/demo/reset` (which extends the 30 days).
- "Sign up for real" link → `/signup` (drops into "Solo" mode).

The `<DemoBanner />` is hidden on `/app/api/*` and `/api/*` routes (no banner inside API responses).

### Cron (extend existing `plan-downgrade.sql`)

Add a new nightly step (same file, same container):
```sql
UPDATE schools
SET plan = 'demo_expired'
WHERE plan = 'demo'
  AND demo_expires_at < now();
```

The existing `plan-downgrade.sql` runs as a chained step after `audit-retention.sql` in the cron container (verified in security batch 1).

### RLS impact

- Demo schools go through the same RLS path as any other school — they get `tenant_isolation` policy applied because they're inserted with the standard schema.
- The `withSchoolId` wrapper added in security batch 1 still works for demo school reads/writes.
- `seedDemoData` uses the system role (`getSystemClient(SYSTEM_DATABASE_URL)`) to bypass RLS during the initial seed. All reads/writes after that use `withSchoolId`.
- `demo.reset` uses `withSchoolId` for the DELETE phase (it scopes to one school) and the system role for the re-seed phase.

## Components & files

**New files:**
- `packages/db/migrations/0006_signup_and_demo.sql` — schema changes + indexes.
- `packages/db/migrations/0007_demo_seed_words.sql` — (no-op, just doc; words live in code).
- `apps/web/server/signup.server.ts` — three signup action functions + `generateSchoolCode`.
- `apps/web/server/demo-seed.server.ts` — `seedDemoData(schoolId, variant)`.
- `apps/web/app/routes/api.signup.join.ts` — POST handler.
- `apps/web/app/routes/api.signup.solo.ts` — POST handler.
- `apps/web/app/routes/api.signup.demo.ts` — POST handler.
- `apps/web/app/routes/app.api.demo.reset.ts` — POST handler.
- `apps/web/app/components/DemoBanner.tsx` — sticky banner component.
- `apps/web/app/components/ExpiredDemo.tsx` — full-page expired state.
- `apps/web/app/components/SignupCard.tsx` — reusable card for the three signup modes.

**Modified files:**
- `packages/db/src/schema.ts` — extend `pgEnum('plan', ...)`, add columns to `schools` table.
- `apps/web/app/routes/signup.tsx` — replace existing school+admin form with three-card layout.
- `apps/web/app/routes/_app.tsx` — render `<DemoBanner />` when `plan === 'demo'`.
- `apps/web/app/routes/_app.settings._index.tsx` — show `join_code` with copy button.
- `db/cron/plan-downgrade.sql` — add demo expiry update.

## Data flow

### Public signup (join existing school)
```
User submits /signup → POST /api/signup/join
  → rate-limit check (signup_attempts table)
  → zod validate
  → SELECT schools WHERE join_code = ?
  → zod check max_teachers quota
  → INSERT users (role=teacher, status=active, school_id=...)
  → INSERT signup_attempts (outcome=success)
  → set session cookie
  → redirect /onboarding/teacher
```

### Public signup (lone teacher)
```
User submits /signup → POST /api/signup/solo
  → rate-limit check
  → zod validate
  → generateSchoolCode(schoolName)
  → BEGIN TX
  → INSERT schools (plan=free, name=?, join_code=?)
  → INSERT users (role=school_admin, status=active, school_id=...)
  → COMMIT
  → INSERT signup_attempts (outcome=success)
  → set session cookie
  → redirect /onboarding/admin
```

### Public signup (demo)
```
User submits /signup → POST /api/signup/demo
  → rate-limit check
  → zod validate
  → generateSchoolCode('Sunrise Elementary')  # uses wordlist fallback
  → BEGIN TX
  → INSERT schools (plan=demo, demo_expires_at=now()+30d, ...)
  → INSERT users (role=school_admin, status=active, school_id=...)
  → seedDemoData(school_id)  # uses system role
  → COMMIT
  → INSERT signup_attempts (outcome=success)
  → set session cookie
  → redirect /app/today
```

### Demo expiry (cron)
```
Nightly 02:00 (cron container) → psql -f plan-downgrade.sql
  → UPDATE schools SET plan='demo_expired' WHERE plan='demo' AND demo_expires_at < now()
```

### Reset demo
```
Admin clicks "Reset demo" → POST /app/api/demo/reset
  → CSRF check
  → auth check (school_admin + plan=demo)
  → BEGIN TX (uses withSchoolId)
  → DELETE FROM coverage_events WHERE school_id=?
  → DELETE FROM coverage_assignments WHERE school_id=?
  → DELETE FROM parent_alerts WHERE school_id=?
  → ... (one DELETE per tenant table)
  → COMMIT
  → seedDemoData(school_id)
  → UPDATE schools SET demo_expires_at = now() + 30 days WHERE id=?
  → redirect /app/today
```

## Error handling

| Failure | User sees | Server response |
|---------|-----------|-----------------|
| Email already in use | "An account with this email already exists. Sign in instead." | 409 + log `outcome='duplicate_email'` |
| School code not found | "School code not recognized. Double-check with your school." | 400 + log `outcome='invalid_code'` |
| School at max_teachers quota | "School is at capacity. Ask your admin to upgrade." | 409 + log `outcome='quota_full'` |
| Password too short | "Password must be at least 8 characters." | 400 (client-side zod, no log) |
| Rate limit hit | "Too many attempts. Try again in 1 hour." | 429 + log `outcome='rate_limited'` |
| School code generation exhausted (extreme) | "Couldn't create your school. Please try again." | 500 + log `outcome='error'` |
| Seed data insert fails | "Demo couldn't be set up. Please try again." | 500 + log `outcome='error'` (transaction rolls back, no orphan school) |

All errors are non-leaky — no DB constraint names or stack traces in the user-facing message.

## Testing

**Unit tests** (vitest):
- `generateSchoolCode` — collision retry behavior, wordlist fallback, 100-retry limit.
- `seedDemoData` — produces expected counts of teachers/duties/events/assignments/alerts; idempotent within a transaction.
- Rate limiter — 5 attempts per email per hour, 20 per IP per hour, rolling window.

**Integration tests** (vitest with a test DB):
- `POST /api/signup/join` happy path: creates user, attaches to school, session cookie set, redirects to /onboarding/teacher.
- `POST /api/signup/join` invalid code: 400 + no user created.
- `POST /api/signup/join` quota full: 409 + no user created.
- `POST /api/signup/solo` happy path: creates school + school_admin, redirects to /onboarding/admin.
- `POST /api/signup/demo` happy path: creates demo school + admin + seed data, redirect to /app/today.
- `POST /app/api/demo/reset` happy path: wipes + re-seeds + extends expiry.
- `POST /app/api/demo/reset` as teacher (non-admin): 403.

**Manual smoke tests** (live, post-deploy):
- Fresh browser, /signup → "Join" → enter a school code (use the one shown in /app/settings for a test school) → land on /onboarding/teacher.
- /signup → "Solo" → enter a school name → land on /onboarding/admin → complete wizard → land on /app/today with empty state.
- /signup → "Demo" → land on /app/today with seeded data → banner shows "30 days" → click "Reset demo" → data re-seeds, banner still shows 30 days.
- Manually set `demo_expires_at` to past via psql → re-login → see ExpiredDemo page → click "Restart demo" → back to /app/today with 30 fresh days.
- Join quota-full school → see capacity error.
- Hammer /api/signup/demo with 21 requests from one IP in 5 minutes → 21st returns 429.

**Security checks**:
- CSRF: all POST endpoints validate the `__Host-edusupervise.csrf` cookie + form/header token (pattern from security batch 1).
- Password hashing: bcrypt with cost=12.
- Email lowercased before insert to prevent duplicate accounts.
- School code is case-insensitive on input but stored as uppercase.
- All SQL parameterized via Drizzle (no string interpolation).
- `signup_attempts` rows are append-only; no PII beyond email + IP.
- Rate limiter must not be bypassable by changing email case (citext handles this).

## Rollout

1. Merge migration 0006 + 0007 + server code + UI.
2. Deploy to VPS (`docker compose up -d --build web`).
3. Run migration against live DB (`pnpm db:migrate`).
4. Update `db/cron/plan-downgrade.sql` and restart cron container.
5. Manual smoke test as listed above.
6. Announce on landing page (no banner change in v1; just rely on /signup's three-card layout to communicate the new path).

## Out of scope (deferred)

- Email verification (Resend is mocked).
- Demo school data export to a real school.
- "Invite by link" for existing schools (code-only for v1).
- Multi-school admin (district).
- Trial expiry emails.
- Demo school analytics (track which variants convert).
- The wordlist being a proper dictionary — for v1 it's hardcoded in the source.

## Open questions

(none — all resolved during brainstorm)
