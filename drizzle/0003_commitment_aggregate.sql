CREATE TYPE "commitmentos"."commitment_status" AS ENUM('DETECTED', 'OPEN', 'DUE_SOON', 'WAITING', 'BLOCKED', 'OVERDUE', 'COMPLETED', 'DISMISSED');--> statement-breakpoint
CREATE TABLE "commitmentos"."commitment" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text,
	"source_message_id" text,
	"commitment_text" text NOT NULL,
	"normalized_action" text NOT NULL,
	"counterparty_name" text,
	"counterparty_email" text,
	"due_at" timestamp with time zone,
	"due_timezone" text,
	"status" "commitmentos"."commitment_status" DEFAULT 'DETECTED' NOT NULL,
	"confidence_score" double precision,
	"source_excerpt" text,
	"completion_evidence" text,
	"completed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commitment_text_nonempty" CHECK (length(btrim("commitment_text")) > 0),
	CONSTRAINT "commitment_action_nonempty" CHECK (length(btrim("normalized_action")) > 0),
	CONSTRAINT "commitment_confidence_score_range" CHECK ("confidence_score" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_workspace_status_due_at_idx" ON "commitmentos"."commitment" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "commitment_workspace_owner_user_id_idx" ON "commitmentos"."commitment" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "commitment_workspace_source_message_idx" ON "commitmentos"."commitment" USING btree ("workspace_id","source_message_id");