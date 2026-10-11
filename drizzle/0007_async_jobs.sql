CREATE TYPE "commitmentos"."async_job_failure_class" AS ENUM('TRANSIENT', 'RATE_LIMITED', 'TIMEOUT', 'AUTHENTICATION', 'PERMANENT', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "commitmentos"."async_job_status" AS ENUM('PENDING', 'QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'DEAD_LETTER', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "commitmentos"."background_worker_status" AS ENUM('READY', 'DRAINING', 'STOPPED');--> statement-breakpoint
CREATE TABLE "commitmentos"."async_job" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "commitmentos"."async_job_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_class" "commitmentos"."async_job_failure_class",
	"error_code" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "async_job_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "async_job_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
	CONSTRAINT "async_job_attempt_count_range" CHECK ("attempt_count" BETWEEN 0 AND "max_attempts"),
	CONSTRAINT "async_job_max_attempts_range" CHECK ("max_attempts" BETWEEN 1 AND 10),
	CONSTRAINT "async_job_timeout_range" CHECK ("timeout_ms" BETWEEN 100 AND 900000),
	CONSTRAINT "async_job_error_code_length" CHECK ("error_code" IS NULL OR length("error_code") <= 96)
);
--> statement-breakpoint
CREATE TABLE "commitmentos"."background_worker_heartbeat" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"status" "commitmentos"."background_worker_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "background_worker_error_code_length" CHECK ("last_error_code" IS NULL OR length("last_error_code") <= 96)
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."async_job" ADD CONSTRAINT "async_job_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."async_job" ADD CONSTRAINT "async_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "commitmentos"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "async_job_status_available_at_idx" ON "commitmentos"."async_job" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "async_job_workspace_status_created_idx" ON "commitmentos"."async_job" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "background_worker_queue_heartbeat_idx" ON "commitmentos"."background_worker_heartbeat" USING btree ("queue_name","status","last_heartbeat_at");