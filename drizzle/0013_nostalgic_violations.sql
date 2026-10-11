ALTER TABLE "commitmentos"."gmail_integration" DROP CONSTRAINT "gmail_integration_scopes_format";--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_oauth_state" ADD COLUMN "oidc_nonce_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_integration" ADD CONSTRAINT "gmail_integration_scopes_format" CHECK ("scopes" = 'email https://www.googleapis.com/auth/gmail.readonly openid');--> statement-breakpoint
ALTER TABLE "commitmentos"."gmail_oauth_state" ADD CONSTRAINT "gmail_oauth_state_oidc_nonce_hash_format" CHECK ("oidc_nonce_hash" ~ '^[a-f0-9]{64}$');