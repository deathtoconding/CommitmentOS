CREATE TABLE "commitmentos"."email_verification_token_use" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_token_use_hash_format" CHECK ("token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "commitmentos"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key"),
	CONSTRAINT "rate_limit_count_nonnegative" CHECK ("count" >= 0),
	CONSTRAINT "rate_limit_last_request_nonnegative" CHECK ("last_request" >= 0)
);
--> statement-breakpoint
CREATE INDEX "email_verification_token_use_expires_at_idx" ON "commitmentos"."email_verification_token_use" USING btree ("expires_at");