# Phase 3 — School-Wide Adoption

**Date:** 2026-07-04
**Status:** Spec ready, ready for swarm dispatch
**Owner:** Coder agent (assigned per swarm dispatch)
**Depends on:** Phase 1 (solo path proven), Phase 2 (PDF ingestion helps bulk import)
**Blocks:** Phase 4 (district multi-tenancy needs the group-duty + recurring-duty model)

## Goal

A solo teacher who loves the app brings their principal. The principal adopts the school-wide plan. The data model grows to support what real schools actually do: group duties (3 teachers covering one slot), recurring time-bound duties ("Early Entry 8:45-9:00 every weekday"), and a billing wall that gates multi-teacher features behind a paid plan.

## What Phase 3 needs to add

### 3.1 Group duties (many-to-many dutyAssignments)

**Why:** Jason's PDF has merged rows like "Cyriac, Loganathan, Sheikh" covering one slot. Today's `dutyAssignments` table is one user → one duty. We need many-to-many.

**Schema change (Migration 0009):**
- `dutyAssignments` already supports multiple rows per `dutyId` (the unique constraint is `userId + dutyId`, not `dutyId` alone — verify). If it does, no schema change needed; just document the allowed cardinality in the comment.
- Add `assignedByUserId` to `dutyAssignments` so admins can mark "this assignment was made by the principal, not by the teacher self-onboarding". Optional, but useful for audit.
- Add `coverageRole` enum: `'primary' | 'backup' | 'rotation'` — so 3 teachers on one slot know who shows up first vs who covers if the first is absent.

**File changes:**
- `packages/db/src/schema.ts` — add `coverageRole` pgEnum, add `assignedByUserId` column to `dutyAssignments`.
- `packages/db/migrations/0009_group_duties.sql` — `ALTER TYPE + CREATE TYPE + ALTER TABLE`.
- `apps/web/server/duty-assignments.server.ts` — new helper for batch-assign operations.
- `apps/web/app/routes/app.duties.$id.tsx` — duty detail page gets a "Assign teachers" multi-select.

**Acceptance:**
- Admin can pick 3+ teachers and assign them to one duty; the system writes 3 rows in `dutyAssignments` with distinct `coverageRole` values.
- `/app/today` for a teacher in a group duty shows "You're covering with [N] others" instead of "You're on duty".
- Coverage requests respect the primary-first ordering: if the primary is absent, the backup gets the SMS, then the rotation slot.

### 3.2 Recurring time-bound duties

**Why:** Jason's second image shows duties like "Early Entry 8:45-9:00 at Kiss N Ride (south end), Back Tarmac". These aren't part of the 5-day cycle — they happen every weekday at the same time. Different model.

**Schema change (Migration 0010):**
- New table `recurringDuties`:
  ```sql
  CREATE TABLE recurring_duties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id UUID NOT NULL REFERENCES schools(id),
    name TEXT NOT NULL,
    location TEXT,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    days_of_week SMALLINT NOT NULL,  -- bitmask: Mon=1, Tue=2, ..., Fri=16
    assigned_user_id UUID REFERENCES users(id),
    requires_vest BOOLEAN DEFAULT FALSE,
    requires_radio BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- New route `apps/web/app/routes/app.recurring._index.tsx` — admin can CRUD.
- New component `RecurringDutyCard` — rendered alongside the cycle-day duties on `/app/today`.
- `apps/web/app/server/reminders.server.ts` — extend to also generate reminders for recurring duties.

**Acceptance:**
- Admin creates "Early Entry 8:45-9:00 at Kiss N Ride, every weekday, assigned to Mrs. Smith".
- Mrs. Smith sees this duty in `/app/today` on Monday morning at 8:45.
- Reminder fires 15 min before (8:30) per Mrs. Smith's reminder style.

### 3.3 Admin billing wall

**Why:** Solo is free. Multi-teacher schools should pay. The wall has to be value-aligned — gated features match what admins actually need that solo teachers don't.

**Gated features (require `schools.plan = 'school'` or higher):**
- More than 5 teachers in the school
- PDF ingestion for the whole school (vs only-for-self in solo)
- Coverage requests sent to all teachers (vs only direct swap in solo)
- Parent alerts (broadcast SMS to a class list)
- Bulk import from CSV
- Custom branding (school logo on the Today screen)

**Free tier behavior:**
- Up to 5 teachers per school.
- Solo features still work for everyone.

**File changes:**
- `apps/web/server/plan-enforcement.server.ts` — already exists (`server/plan-enforcement.server.ts`), extend it to gate the new features.
- `apps/web/app/routes/app.settings.billing.tsx` — already exists, add new "Compare plans" view.
- `apps/web/app/routes/api.billing.checkout.tsx` — already exists, add `school` plan tier (priced per-month, 14-day trial).
- `apps/web/app/components/UpgradePrompt.tsx` (new) — modal shown when a free-school admin tries a gated feature.

**Acceptance:**
- Free school with 6 teachers can't add the 6th; sees an upgrade prompt.
- Free school admin clicks "Coverage requests for all teachers" → sees a modal explaining the upgrade.
- Paid school (plan='school') can use all gated features without prompts.

### 3.4 Coverage request broadcast (depends on 3.1 + 3.3)

**Why:** Today, coverage requests are 1-to-1. Real schools want to broadcast "Mrs. Smith is sick, can anyone cover her 11:30 cafeteria duty?" to all eligible teachers.

**File changes:**
- `apps/web/server/coverage.server.ts` — extend with broadcast mode.
- `apps/web/app/routes/app.coverage._index.tsx` — add "Broadcast" toggle.
- New route `api.coverage.broadcast.ts` — POST creates one row per eligible teacher.

**Acceptance:**
- Admin creates broadcast → N rows in `coverageEvents` (one per eligible teacher).
- Each teacher gets the SMS/email; first to accept wins.
- Remaining rows auto-cancel when one is accepted.

## Out of scope (Phase 4+)

- District multi-tenancy (Phase 4)
- Board-level PDF ingestion (Phase 4)
- SSO (Phase 4)
- API for SIS integration (Phase 4)

## Verification checklist

- [ ] All migrations apply cleanly on the live DB without downtime
- [ ] Demo school still works (Sunrise Elementary + 4 teachers + 1 EA + duties + assignments)
- [ ] Free school of 5 teachers can use all non-gated features
- [ ] Free school trying to add a 6th teacher sees the upgrade prompt
- [ ] Paid school can add unlimited teachers
- [ ] Coverage request broadcast fires SMS to all eligible teachers within 30 seconds
- [ ] Group duty of 3 teachers renders correctly on `/app/today` for all 3
- [ ] Recurring duty fires reminders on the right days at the right time
- [ ] No new TODOs left in the code
- [ ] Commits per file-ownership boundary

## Estimated size

- 2 migrations (0009 group duties, 0010 recurring duties)
- 5-7 new routes/components
- 3-4 modified routes
- ~1200 LOC + ~1000 LOC tests
- Single coder worker, ~7-10 days calendar time

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Group duty cardinality gets messy with role ordering | Start with `primary/backup/rotation` only; add more if teachers ask |
| Recurring duty schema doesn't support exceptions (holidays, snow days) | Don't build exceptions in Phase 3 — admin can deactivate the duty for the day. Build proper exceptions in Phase 4. |
| Billing wall confuses users | Show clear "X is a paid feature" copy. Offer a 14-day trial without a credit card. |
| Coverage broadcasts spam teachers | Default to "broadcast to all eligible" with an opt-out per teacher in settings. |