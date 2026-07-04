-- Migration 0007: Add 'educational_assistant' to user role check constraint
-- (docs/superpowers/specs/2026-07-04--solo-teacher-scaling.md)
--
-- Background: Jason (Toronto teacher, beta feedback 2026-07-04) shared
-- his real-world duty roster, which separates Educational Assistants
-- (EAs) from teachers as a first-class concept in the rotation grid.
-- The current `users_role_check` constraint only allows 'school_admin',
-- 'teacher', 'substitute' — there's no way to onboard an EA.
--
-- Why ALTER CONSTRAINT instead of ALTER TYPE:
-- The live DB stores `users.role` as TEXT with a CHECK constraint
-- (`users_role_check`), not a PG enum. The drizzle-side `pgEnum` in
-- packages/db/src/schema.ts is a TypeScript abstraction only; the
-- actual constraint lives in users_role_check. The init SQL in
-- db/init/02-schema.sql predates the CHECK-vs-enum decision (audit
-- slice-3 R-F1, 2026-06-30).
--
-- Phase 0 UI follow-up: the new role has no on-screen entry path
-- yet — signup flows still pick from school_admin/teacher/substitute.
-- That's intentional. Phase 1 (solo teacher onboarding) will add the
-- "I'm an EA" branch and the JOIN-school join form will get the new
-- role option.
--
-- Idempotency: NOT idempotent. The DROP CONSTRAINT will fail if the
-- constraint doesn't exist (already migrated). The `IF EXISTS` form
-- is used so re-running this migration on a fresh DB after init
-- scripts is safe even when init already added 'educational_assistant'.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;--> statement-breakpoint

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY[
    'school_admin'::text,
    'teacher'::text,
    'educational_assistant'::text,
    'substitute'::text
  ]));--> statement-breakpoint