-- Migration 0002: Coverage Router (Phase 2B)
--
-- The Coverage Router is the load-bearing adjacent opportunity from
-- the research synthesis (slice 2, opportunity 1). When a teacher is
-- out, it extends the duty scheduler to absorb the absent teacher's
-- duties and notify a replacement. No incumbent owns this gap.
--
-- Tables:
--   coverage_events: one row per absence event (teacher is out on a date)
--   coverage_assignments: one row per (coverage_event, duty) — the rerouted duty
--
-- Both tenant-scoped via RLS (FORCE ROW LEVEL SECURITY), consistent
-- with the rest of the schema.

CREATE TABLE IF NOT EXISTS "coverage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"absence_date" date NOT NULL,
	"reason" text,
	"status" text NOT NULL DEFAULT 'open',
	"source" text NOT NULL DEFAULT 'direct',
	"external_id" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_events_status_check" CHECK ("coverage_events"."status" IN ('open', 'routed', 'closed')),
	CONSTRAINT "coverage_events_source_check" CHECK ("coverage_events"."source" IN ('direct', 'frontline', 'red_rover', 'swing', 'manual'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "coverage_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"coverage_event_id" uuid NOT NULL,
	"duty_id" uuid NOT NULL,
	"original_teacher_id" uuid NOT NULL,
	"new_teacher_id" uuid,
	"status" text NOT NULL DEFAULT 'pending',
	"notified_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_assignments_status_check" CHECK ("coverage_assignments"."status" IN ('pending', 'accepted', 'declined', 'uncovered'))
);
--> statement-breakpoint

-- Foreign keys
ALTER TABLE "coverage_events" ADD CONSTRAINT "coverage_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_events" ADD CONSTRAINT "coverage_events_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_events" ADD CONSTRAINT "coverage_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_assignments" ADD CONSTRAINT "coverage_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_assignments" ADD CONSTRAINT "coverage_assignments_coverage_event_id_coverage_events_id_fk" FOREIGN KEY ("coverage_event_id") REFERENCES "public"."coverage_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_assignments" ADD CONSTRAINT "coverage_assignments_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_assignments" ADD CONSTRAINT "coverage_assignments_original_teacher_id_users_id_fk" FOREIGN KEY ("original_teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_assignments" ADD CONSTRAINT "coverage_assignments_new_teacher_id_users_id_fk" FOREIGN KEY ("new_teacher_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Indexes for the common queries:
--   - find open absences for a date: coverage_events(school_id, absence_date, status)
--   - find pending coverage for a teacher: coverage_assignments(new_teacher_id, status)
--   - find unaccepted coverage: coverage_assignments(school_id, status) WHERE status='pending'
CREATE INDEX IF NOT EXISTS "coverage_events_school_date_status_idx" ON "coverage_events" ("school_id", "absence_date", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverage_assignments_school_status_idx" ON "coverage_assignments" ("school_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coverage_assignments_new_teacher_idx" ON "coverage_assignments" ("new_teacher_id", "status");--> statement-breakpoint

-- Idempotency: match an incoming Frontline / Red Rover absence to an
-- existing event so we don't double-route if the webhook fires twice.
CREATE UNIQUE INDEX IF NOT EXISTS "coverage_events_external_id_unique" ON "coverage_events" ("source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint

-- Table-level grants. The init-time grant procedure in 02-schema.sql
-- only runs on fresh DBs (via /docker-entrypoint-initdb.d), so on
-- existing DBs where these tables were created by this migration we
-- need to grant explicitly. Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.coverage_events      TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.coverage_events      TO edusupervise_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.coverage_assignments TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.coverage_assignments TO edusupervise_system;--> statement-breakpoint
