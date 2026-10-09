CREATE TYPE "commitmentos"."gmail_integration_audit_event_type" AS ENUM('CONNECTED', 'REVOCATION_REQUESTED', 'REVOCATION_ATTEMPT_FAILED', 'DISCONNECTED');--> statement-breakpoint
CREATE TYPE "commitmentos"."gmail_integration_status" AS ENUM('CONNECTED', 'REAUTH_REQUIRED', 'REVOCATION_PENDING', 'DISCONNECTED');--> statement-breakpoint
CREATE TABLE "commitmentos"."gmail_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_email" text NOT NULL,
	"status" "commitmentos"."gmail_integration_status" DEFAULT 'CONNECTED' NOT NULL,
	"scopes" text NOT NULL,
	"credentials_ciphertext" text,
	"access_token_expires_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_integration_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "gmail_integration_workspace_account_unique" UNIQUE("workspace_id","provider_account_id"),
	CONSTRAINT "gmail_integration_provider_account_id_format" CHECK (length("provider_account_id") BETWEEN 1 AND 255
        AND "provider_account_id" = btrim("provider_account_id")
        AND "provider_account_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "gmail_integration_provider_email_format" CHECK (length("provider_email") BETWEEN 3 AND 320
        AND "provider_email" = btrim("provider_email")
        AND "provider_email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
	CONSTRAINT "gmail_integration_scopes_format" CHECK (length("scopes") BETWEEN 1 AND 2048
        AND position('https://www.googleapis.com/auth/gmail.readonly' in "scopes") > 0
        AND position('https://www.googleapis.com/auth/userinfo.email' in "scopes") > 0),
	CONSTRAINT "gmail_integration_credentials_status_consistency" CHECK (("status" = 'DISCONNECTED' AND "credentials_ciphertext" IS NULL
          AND "access_token_expires_at" IS NULL)
        OR
        ("status" <> 'DISCONNECTED' AND "credentials_ciphertext" IS NOT NULL
          AND "access_token_expires_at" IS NOT NULL)),
	CONSTRAINT "gmail_integration_ciphertext_format" CHECK ("credentials_ciphertext" IS NULL OR "credentials_ciphertext" ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
CREATE TABLE "commitmentos"."gmail_integration_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"event_type" "commitmentos"."gmail_integration_audit_event_type" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_integration_audit_event_details_object" CHECK (jsonb_typeof("details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "commitmentos"."gmail_oauth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"browser_token_hash" text NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_oauth_state_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "gmail_oauth_state_workspace_user_unique" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "gmail_oauth_state_hash_format" CHECK ("state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gmail_oauth_state_browser_hash_format" CHECK ("browser_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gmail_oauth_state_verifier_ciphertext_format" CHECK ("code_verifier_ciphertext" ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_integration" ADD CONSTRAINT "gmail_integration_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_integration" ADD CONSTRAINT "gmail_integration_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_integration_audit_event" ADD CONSTRAINT "gmail_integration_audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_integration_audit_event" ADD CONSTRAINT "gmail_integration_audit_event_workspace_integration_fk" FOREIGN KEY ("workspace_id","integration_id") REFERENCES "commitmentos"."gmail_integration"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_oauth_state" ADD CONSTRAINT "gmail_oauth_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_oauth_state" ADD CONSTRAINT "gmail_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "commitmentos"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gmail_integration_workspace_status_idx" ON "commitmentos"."gmail_integration" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "gmail_integration_audit_event_workspace_occurred_idx" ON "commitmentos"."gmail_integration_audit_event" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "gmail_integration_audit_event_integration_occurred_idx" ON "commitmentos"."gmail_integration_audit_event" USING btree ("integration_id","occurred_at");--> statement-breakpoint
CREATE INDEX "gmail_oauth_state_expiry_idx" ON "commitmentos"."gmail_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE FUNCTION "commitmentos"."reject_gmail_integration_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Gmail integration audit events are immutable'
    USING ERRCODE = '55000';
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "gmail_integration_audit_event_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "commitmentos"."gmail_integration_audit_event"
FOR EACH ROW EXECUTE FUNCTION "commitmentos"."reject_gmail_integration_audit_event_mutation"();--> statement-breakpoint
CREATE TRIGGER "gmail_integration_audit_event_no_truncate"
BEFORE TRUNCATE ON "commitmentos"."gmail_integration_audit_event"
FOR EACH STATEMENT EXECUTE FUNCTION "commitmentos"."reject_gmail_integration_audit_event_mutation"();