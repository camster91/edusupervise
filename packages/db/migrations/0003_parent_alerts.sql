-- Migration 0003: Parent-facing duty-change alerts (Phase 3)
--
-- When the Coverage Router accepts a coverage request (or the duty
-- swap is otherwise finalised), EduSupervise generates a targeted
-- parent alert. The alert goes to parents whose students are
-- associated with the duty (matched by route tags like "Bus 7",
-- "Recess K-2", etc.).
--
-- Tables:
--   parent_contacts: one row per parent. v1: name + phone + email.
--                    v2: opt-in preferences, language, etc.
--   parent_route_tags: many-to-many between parents and route tags
--                    (e.g., "Bus 7", "Recess", "Cafeteria", "Dismissal")
--   parent_alerts: one row per (parent, coverage_assignment) — the
--                    generated alert. Status drives the dispatch flow.
--
-- Both tables are tenant-scoped via RLS (FORCE ROW LEVEL SECURITY).

CREATE TABLE IF NOT EXISTS "parent_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"language" text DEFAULT 'en' NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_contacts_name_length" CHECK (length("parent_contacts"."name") >= 1 AND length("parent_contacts"."name") <= 200),
	CONSTRAINT "parent_contacts_phone_or_email" CHECK ("parent_contacts"."phone" IS NOT NULL OR "parent_contacts"."email" IS NOT NULL)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "parent_route_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_route_tags_tag_length" CHECK (length("parent_route_tags"."tag") >= 1 AND length("parent_route_tags"."tag") <= 100)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "parent_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"coverage_assignment_id" uuid NOT NULL,
	"channel" text NOT NULL DEFAULT 'sms',
	"subject" text,
	"body_short" text NOT NULL,
	"body_long" text,
	"status" text NOT NULL DEFAULT 'draft',
	"sent_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_alerts_channel_check" CHECK ("parent_alerts"."channel" IN ('sms', 'email', 'app')),
	CONSTRAINT "parent_alerts_status_check" CHECK ("parent_alerts"."status" IN ('draft', 'queued', 'sent', 'failed', 'cancelled'))
);
--> statement-breakpoint

-- Foreign keys
ALTER TABLE "parent_contacts" ADD CONSTRAINT "parent_contacts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_route_tags" ADD CONSTRAINT "parent_route_tags_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_route_tags" ADD CONSTRAINT "parent_route_tags_parent_id_parent_contacts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_alerts" ADD CONSTRAINT "parent_alerts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_alerts" ADD CONSTRAINT "parent_alerts_parent_id_parent_contacts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_alerts" ADD CONSTRAINT "parent_alerts_coverage_assignment_id_coverage_assignments_id_fk" FOREIGN KEY ("coverage_assignment_id") REFERENCES "public"."coverage_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Idempotency: one parent_alert per (parent, coverage_assignment).
-- Re-running generateAlertsForAssignment should be a no-op, not double-alert.
CREATE UNIQUE INDEX IF NOT EXISTS "parent_alerts_parent_assignment_unique" ON "parent_alerts" ("parent_id", "coverage_assignment_id");--> statement-breakpoint

-- Indexes for the common queries
CREATE INDEX IF NOT EXISTS "idx_parent_contacts_school" ON "parent_contacts" ("school_id") WHERE "parent_contacts"."opted_out_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_parent_route_tags_school_tag" ON "parent_route_tags" ("school_id", "tag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_parent_alerts_school_status" ON "parent_alerts" ("school_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_parent_alerts_assignment" ON "parent_alerts" ("coverage_assignment_id");--> statement-breakpoint

-- Table-level grants. The init-time grant procedure in 02-schema.sql
-- only runs on fresh DBs (via /docker-entrypoint-initdb.d), so on
-- existing DBs where these tables were created by this migration we
-- need to grant explicitly. Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_contacts   TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_contacts   TO edusupervise_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_route_tags TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_route_tags TO edusupervise_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_alerts     TO edusupervise_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.parent_alerts     TO edusupervise_system;--> statement-breakpoint
