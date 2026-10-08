CREATE TYPE "commitmentos"."source_provider" AS ENUM('GMAIL', 'SLACK');--> statement-breakpoint
CREATE TABLE "commitmentos"."source_message" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" "commitmentos"."source_provider",
	"provider_account_id" text,
	"provider_message_id" text,
	"provider_timestamp" timestamp with time zone,
	"legacy_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_message_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_message_workspace_legacy_reference_unique" UNIQUE("workspace_id","legacy_reference"),
	CONSTRAINT "source_message_provider_identity_unique" UNIQUE("workspace_id","provider","provider_account_id","provider_message_id"),
	CONSTRAINT "source_message_identity_shape" CHECK ((
        ("provider" IS NULL AND "provider_account_id" IS NULL AND "provider_message_id" IS NULL
          AND "provider_timestamp" IS NULL AND "legacy_reference" IS NOT NULL)
        OR
        ("provider" IS NOT NULL AND "provider_account_id" IS NOT NULL
          AND "provider_message_id" IS NOT NULL AND "legacy_reference" IS NULL)
      )),
	CONSTRAINT "source_message_provider_identifiers_nonempty" CHECK ("provider" IS NULL OR (
        length(btrim("provider_account_id")) BETWEEN 1 AND 1024
        AND length(btrim("provider_message_id")) BETWEEN 1 AND 2048
        AND length("provider_account_id") <= 1024
        AND length("provider_message_id") <= 2048
      ))
);
--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD COLUMN "source_message_record_id" text;--> statement-breakpoint
-- Preserve existing opaque references exactly; no provider, account, or source timestamp is inferred.
INSERT INTO "commitmentos"."source_message" (id, workspace_id, legacy_reference)
SELECT gen_random_uuid()::text, commitment.workspace_id, commitment.source_message_id
FROM "commitmentos"."commitment" AS commitment
WHERE commitment.source_message_id IS NOT NULL
GROUP BY commitment.workspace_id, commitment.source_message_id;--> statement-breakpoint
ALTER TABLE "commitmentos"."source_message" ADD CONSTRAINT "source_message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "commitmentos"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_message_workspace_created_at_idx" ON "commitmentos"."source_message" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_workspace_source_message_record_fk" FOREIGN KEY ("workspace_id","source_message_record_id") REFERENCES "commitmentos"."source_message"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_workspace_legacy_source_message_fk" FOREIGN KEY ("workspace_id","source_message_id") REFERENCES "commitmentos"."source_message"("workspace_id","legacy_reference") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_workspace_source_message_record_idx" ON "commitmentos"."commitment" USING btree ("workspace_id","source_message_record_id");--> statement-breakpoint
ALTER TABLE "commitmentos"."commitment" ADD CONSTRAINT "commitment_source_message_reference_xor" CHECK ("source_message_id" IS NULL OR "source_message_record_id" IS NULL);