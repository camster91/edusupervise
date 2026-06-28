CREATE TYPE "public"."notification_kind" AS ENUM('reminder.failed', 'plan.downgrade.pending', 'plan.downgrade.applied', 'system.message');--> statement-breakpoint
CREATE TYPE "public"."reminder_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."school_plan" AS ENUM('trial', 'free', 'pro', 'school');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('school_admin', 'teacher', 'substitute');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"duty_assignment_id" uuid NOT NULL,
	"date" date NOT NULL,
	"google_event_id" text NOT NULL,
	"google_etag" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_links_school_assignment_date_unique" UNIQUE("school_id","duty_assignment_id","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cycle_calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"date" date NOT NULL,
	"cycle_day" integer,
	"is_school_day" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_calendar_school_date_unique" UNIQUE("school_id","date"),
	CONSTRAINT "cycle_calendar_day_range" CHECK ("cycle_calendar"."cycle_day" IS NULL OR ("cycle_calendar"."cycle_day" >= 1 AND "cycle_calendar"."cycle_day" <= 10)),
	CONSTRAINT "cycle_calendar_note_length" CHECK ("cycle_calendar"."note" IS NULL OR length("cycle_calendar"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"cycle_day" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"location" text NOT NULL,
	"description" text,
	"requires_vest" boolean DEFAULT false NOT NULL,
	"requires_radio" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duties_cycle_day_min" CHECK ("duties"."cycle_day" >= 1),
	CONSTRAINT "duties_description_length" CHECK ("duties"."description" IS NULL OR length("duties"."description") <= 1000),
	CONSTRAINT "duties_end_after_start" CHECK ("duties"."end_time" > "duties"."start_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duty_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"duty_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duty_assignments_end_after_start" CHECK ("duty_assignments"."end_date" IS NULL OR "duty_assignments"."end_date" >= "duty_assignments"."start_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "google_calendar_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expiry_date" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"google_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_calendar_tokens_school_user_unique" UNIQUE("school_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_url" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_limits" (
	"plan" text PRIMARY KEY NOT NULL,
	"max_teachers" integer NOT NULL,
	"max_duties" integer NOT NULL,
	"max_reminders_per_assignment" integer NOT NULL,
	"sms_included" boolean DEFAULT false NOT NULL,
	"audit_retention_days" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"reminder_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"channel" "reminder_channel" NOT NULL,
	"status" "reminder_status" NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"minutes_before" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"notify_email" boolean DEFAULT true NOT NULL,
	"notify_sms" boolean DEFAULT false NOT NULL,
	"custom_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_minutes_range" CHECK ("reminders"."minutes_before" >= 0 AND "reminders"."minutes_before" <= 10080),
	CONSTRAINT "reminders_custom_message_length" CHECK ("reminders"."custom_message" IS NULL OR length("reminders"."custom_message") <= 500)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"cycle_days" integer DEFAULT 5 NOT NULL,
	"school_year_start" date NOT NULL,
	"school_year_end" date NOT NULL,
	"plan" "school_plan" DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"plan_downgrade_pending_to" text,
	"plan_downgrade_effective_at" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"logo_url" text,
	"accent_color" text DEFAULT '#3b82f6',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schools_slug_unique" UNIQUE("slug"),
	CONSTRAINT "schools_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "schools_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "schools_cycle_days_range" CHECK ("schools"."cycle_days" BETWEEN 1 AND 10),
	CONSTRAINT "schools_year_end_after_start" CHECK ("schools"."school_year_end" > "schools"."school_year_start"),
	CONSTRAINT "schools_year_within_14_months" CHECK ("schools"."school_year_end" <= "schools"."school_year_start" + interval '14 months')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"phone" text,
	"phone_verified_at" timestamp with time zone,
	"avatar_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_school_id_email_unique" UNIQUE("school_id","email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_beat" timestamp with time zone NOT NULL,
	"jobs_completed" bigserial DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_duty_assignment_id_duty_assignments_id_fk" FOREIGN KEY ("duty_assignment_id") REFERENCES "public"."duty_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cycle_calendar" ADD CONSTRAINT "cycle_calendar_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duties" ADD CONSTRAINT "duties_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duties" ADD CONSTRAINT "duties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_duty_id_duties_id_fk" FOREIGN KEY ("duty_id") REFERENCES "public"."duties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_assignments" ADD CONSTRAINT "duty_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_calendar_tokens" ADD CONSTRAINT "google_calendar_tokens_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "google_calendar_tokens" ADD CONSTRAINT "google_calendar_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_assignment_id_duty_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."duty_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_log" ADD CONSTRAINT "reminder_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_assignment_id_duty_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."duty_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_school_created" ON "audit_log" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_target" ON "audit_log" USING btree ("school_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calendar_event_links_school_duty" ON "calendar_event_links" USING btree ("school_id","duty_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calendar_event_links_google_event_id" ON "calendar_event_links" USING btree ("google_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cycle_calendar_school_date" ON "cycle_calendar" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_duties_school_cycle" ON "duties" USING btree ("school_id","cycle_day") WHERE "duties"."is_active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assignments_school_user" ON "duty_assignments" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assignments_school_duty" ON "duty_assignments" USING btree ("school_id","duty_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_google_calendar_tokens_school_user" ON "google_calendar_tokens" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_pending" ON "outbox" USING btree ("created_at") WHERE "outbox"."enqueued_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_school_user_endpoint_unique" ON "push_subscriptions" USING btree ("school_id","user_id","endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user" ON "push_subscriptions" USING btree ("school_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_log_dedup_unique" ON "reminder_log" USING btree ("reminder_id","scheduled_for","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reminder_log_school_status" ON "reminder_log" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reminder_log_assignment" ON "reminder_log" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reminders_school_assignment" ON "reminders" USING btree ("school_id","assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schools_slug" ON "schools" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_school_id" ON "users" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" USING btree ("email");