CREATE TYPE "commitmentos"."commitment_audit_event_type" AS ENUM('CREATED', 'EDITED', 'CONFIRMED', 'DISMISSED', 'REASSIGNED', 'DEADLINE_CHANGED', 'STATUS_CHANGED', 'COMPLETED', 'COMPLETION_EVIDENCE_RECORDED', 'FOLLOW_UP_GENERATED', 'APPROVED', 'SENT');--> statement-breakpoint
CREATE TABLE "commitmentos"."commitment_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"commitment_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"event_type" "commitmentos"."commitment_audit_event_type" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitment_audit_event_details_object" CHECK (jsonb_typeof("details") = 'object')
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment_audit_event" ADD CONSTRAINT "commitment_audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment_audit_event" ADD CONSTRAINT "commitment_audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment_audit_event" ADD CONSTRAINT "commitment_audit_event_workspace_commitment_fk" FOREIGN KEY ("workspace_id","commitment_id") REFERENCES "commitmentos"."commitment"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_audit_event_workspace_commitment_occurred_idx" ON "commitmentos"."commitment_audit_event" USING btree ("workspace_id","commitment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "commitment_audit_event_workspace_occurred_idx" ON "commitmentos"."commitment_audit_event" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE FUNCTION "commitmentos"."reject_commitment_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'commitment audit events are immutable'
    USING ERRCODE = '55000';
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "commitment_audit_event_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "commitmentos"."commitment_audit_event"
FOR EACH ROW EXECUTE FUNCTION "commitmentos"."reject_commitment_audit_event_mutation"();--> statement-breakpoint
CREATE TRIGGER "commitment_audit_event_no_truncate"
BEFORE TRUNCATE ON "commitmentos"."commitment_audit_event"
FOR EACH STATEMENT EXECUTE FUNCTION "commitmentos"."reject_commitment_audit_event_mutation"();
