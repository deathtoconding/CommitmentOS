ALTER TABLE "commitmentos"."email_verification_token_use" ALTER COLUMN "consumed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commitmentos"."email_verification_token_use" ADD COLUMN "use_status" text DEFAULT 'CONSUMED' NOT NULL;--> statement-breakpoint
ALTER TABLE "commitmentos"."email_verification_token_use" ADD COLUMN "reservation_id" text;--> statement-breakpoint
ALTER TABLE "commitmentos"."email_verification_token_use" ADD COLUMN "reservation_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commitmentos"."email_verification_token_use" ADD CONSTRAINT "email_verification_token_use_status_format" CHECK ("use_status" IN ('RESERVED', 'CONSUMED'));--> statement-breakpoint
ALTER TABLE "commitmentos"."email_verification_token_use" ADD CONSTRAINT "email_verification_token_use_reservation_consistency" CHECK (("use_status" = 'CONSUMED' AND "consumed_at" IS NOT NULL
          AND "reservation_expires_at" IS NULL)
        OR ("use_status" = 'RESERVED' AND "consumed_at" IS NULL
          AND "reservation_id" IS NOT NULL AND "reservation_expires_at" IS NOT NULL));