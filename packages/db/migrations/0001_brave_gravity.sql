CREATE TABLE IF NOT EXISTS "auth_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_account_user_provider_unique" ON "auth_account" USING btree ("userId","providerId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_account_user" ON "auth_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_verification_identifier" ON "auth_verification" USING btree ("identifier");
--> statement-breakpoint
-- Grants for the new better-auth tables. The init script's GRANT loop
-- in 02-schema.sql only sees tables that existed at init time; the auth
-- tables are created here so we must grant them explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_session"      TO edusupervise_runtime, edusupervise_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_account"      TO edusupervise_runtime, edusupervise_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_verification" TO edusupervise_runtime, edusupervise_system;