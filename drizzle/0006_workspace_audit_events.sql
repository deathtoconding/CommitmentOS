CREATE TYPE "commitmentos"."workspace_audit_event_type" AS ENUM('WORKSPACE_CREATED', 'MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED');--> statement-breakpoint
CREATE TABLE "commitmentos"."workspace_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"event_type" "commitmentos"."workspace_audit_event_type" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_audit_event_details_object" CHECK (jsonb_typeof("details") = 'object')
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."workspace_audit_event" ADD CONSTRAINT "workspace_audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."workspace_audit_event" ADD CONSTRAINT "workspace_audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."workspace_audit_event" ADD CONSTRAINT "workspace_audit_event_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "commitmentos"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_audit_event_workspace_occurred_idx" ON "commitmentos"."workspace_audit_event" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "workspace_audit_event_target_occurred_idx" ON "commitmentos"."workspace_audit_event" USING btree ("workspace_id","target_user_id","occurred_at");--> statement-breakpoint
CREATE FUNCTION "commitmentos"."reject_workspace_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace audit events are immutable'
    USING ERRCODE = '55000';
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_audit_event_no_update_or_delete"
BEFORE UPDATE OR DELETE ON "commitmentos"."workspace_audit_event"
FOR EACH ROW EXECUTE FUNCTION "commitmentos"."reject_workspace_audit_event_mutation"();--> statement-breakpoint
CREATE TRIGGER "workspace_audit_event_no_truncate"
BEFORE TRUNCATE ON "commitmentos"."workspace_audit_event"
FOR EACH STATEMENT EXECUTE FUNCTION "commitmentos"."reject_workspace_audit_event_mutation"();
