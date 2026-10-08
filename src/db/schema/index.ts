import { sql } from 'drizzle-orm';
import { COMMITMENT_AUDIT_EVENT_TYPES } from '../../commitments/audit-model';
import { COMMITMENT_STATUSES } from '../../commitments/model';
import { JOB_STATUSES } from '../../jobs/model';
import { WORKSPACE_AUDIT_EVENT_TYPES } from '../../workspaces/audit-model';
import { SOURCE_MESSAGE_PROVIDERS } from '../../source-messages/model';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Database namespace reserved for CommitmentOS application tables. */
export const commitmentosSchema = pgSchema('commitmentos');

export const user = commitmentosSchema.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const session = commitmentosSchema.table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = commitmentosSchema.table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = commitmentosSchema.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const rateLimit = commitmentosSchema.table(
  'rate_limit',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (_table) => [
    check('rate_limit_count_nonnegative', sql`"count" >= 0`),
    check('rate_limit_last_request_nonnegative', sql`"last_request" >= 0`),
  ],
);

export const emailVerificationTokenUse = commitmentosSchema.table(
  'email_verification_token_use',
  {
    tokenHash: text('token_hash').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('email_verification_token_use_hash_format', sql`"token_hash" ~ '^[a-f0-9]{64}$'`),
    index('email_verification_token_use_expires_at_idx').on(table.expiresAt),
  ],
);

export const workspaceRole = commitmentosSchema.enum('workspace_role', ['OWNER', 'MEMBER']);

export const workspace = commitmentosSchema.table('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const workspaceMember = commitmentosSchema.table(
  'workspace_member',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').default('MEMBER').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('workspace_member_workspace_user_unique').on(table.workspaceId, table.userId),
    index('workspace_member_user_id_idx').on(table.userId),
  ],
);

export type WorkspaceRole = (typeof workspaceRole.enumValues)[number];

export const workspaceAuditEventType = commitmentosSchema.enum(
  'workspace_audit_event_type',
  WORKSPACE_AUDIT_EVENT_TYPES,
);

export const workspaceAuditEvent = commitmentosSchema.table(
  'workspace_audit_event',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    eventType: workspaceAuditEventType('event_type').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('workspace_audit_event_details_object', sql`jsonb_typeof("details") = 'object'`),
    index('workspace_audit_event_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
    index('workspace_audit_event_target_occurred_idx').on(
      table.workspaceId,
      table.targetUserId,
      table.occurredAt,
    ),
  ],
);

export const sourceProvider = commitmentosSchema.enum('source_provider', SOURCE_MESSAGE_PROVIDERS);

export const sourceMessage = commitmentosSchema.table(
  'source_message',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    provider: sourceProvider('provider'),
    providerAccountId: text('provider_account_id'),
    providerMessageId: text('provider_message_id'),
    providerTimestamp: timestamp('provider_timestamp', { withTimezone: true, mode: 'date' }),
    legacyReference: text('legacy_reference'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('source_message_workspace_id_unique').on(table.workspaceId, table.id),
    unique('source_message_workspace_legacy_reference_unique').on(
      table.workspaceId,
      table.legacyReference,
    ),
    unique('source_message_provider_identity_unique').on(
      table.workspaceId,
      table.provider,
      table.providerAccountId,
      table.providerMessageId,
    ),
    check(
      'source_message_identity_shape',
      sql`(
        ("provider" IS NULL AND "provider_account_id" IS NULL AND "provider_message_id" IS NULL
          AND "provider_timestamp" IS NULL AND "legacy_reference" IS NOT NULL)
        OR
        ("provider" IS NOT NULL AND "provider_account_id" IS NOT NULL
          AND "provider_message_id" IS NOT NULL AND "legacy_reference" IS NULL)
      )`,
    ),
    check(
      'source_message_provider_identifiers_nonempty',
      sql`"provider" IS NULL OR (
        length(btrim("provider_account_id")) BETWEEN 1 AND 1024
        AND length(btrim("provider_message_id")) BETWEEN 1 AND 2048
        AND length("provider_account_id") <= 1024
        AND length("provider_message_id") <= 2048
      )`,
    ),
    index('source_message_workspace_created_at_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const commitmentStatus = commitmentosSchema.enum('commitment_status', COMMITMENT_STATUSES);

export const commitment = commitmentosSchema.table(
  'commitment',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    // Retained only for existing opaque references; new links use a workspace-scoped source record.
    sourceMessageId: text('source_message_id'),
    sourceMessageRecordId: text('source_message_record_id'),
    commitmentText: text('commitment_text').notNull(),
    normalizedAction: text('normalized_action').notNull(),
    counterpartyName: text('counterparty_name'),
    counterpartyEmail: text('counterparty_email'),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    dueTimezone: text('due_timezone'),
    status: commitmentStatus('status').default('DETECTED').notNull(),
    confidenceScore: doublePrecision('confidence_score'),
    sourceExcerpt: text('source_excerpt'),
    completionEvidence: text('completion_evidence'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('commitment_text_nonempty', sql`length(btrim("commitment_text")) > 0`),
    check('commitment_action_nonempty', sql`length(btrim("normalized_action")) > 0`),
    check('commitment_confidence_score_range', sql`"confidence_score" BETWEEN 0 AND 1`),
    check(
      'commitment_source_message_reference_xor',
      sql`"source_message_id" IS NULL OR "source_message_record_id" IS NULL`,
    ),
    foreignKey({
      name: 'commitment_workspace_source_message_record_fk',
      columns: [table.workspaceId, table.sourceMessageRecordId],
      foreignColumns: [sourceMessage.workspaceId, sourceMessage.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'commitment_workspace_legacy_source_message_fk',
      columns: [table.workspaceId, table.sourceMessageId],
      foreignColumns: [sourceMessage.workspaceId, sourceMessage.legacyReference],
    }).onDelete('restrict'),
    unique('commitment_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('commitment_workspace_status_due_at_idx').on(
      table.workspaceId,
      table.status,
      table.dueAt,
    ),
    index('commitment_workspace_created_at_id_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    index('commitment_workspace_owner_user_id_idx').on(table.workspaceId, table.ownerUserId),
    index('commitment_workspace_source_message_idx').on(table.workspaceId, table.sourceMessageId),
    index('commitment_workspace_source_message_record_idx').on(
      table.workspaceId,
      table.sourceMessageRecordId,
    ),
  ],
);

export const commitmentAuditEventType = commitmentosSchema.enum(
  'commitment_audit_event_type',
  COMMITMENT_AUDIT_EVENT_TYPES,
);

export const commitmentAuditEvent = commitmentosSchema.table(
  'commitment_audit_event',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    commitmentId: text('commitment_id').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    eventType: commitmentAuditEventType('event_type').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'commitment_audit_event_workspace_commitment_fk',
      columns: [table.workspaceId, table.commitmentId],
      foreignColumns: [commitment.workspaceId, commitment.id],
    }).onDelete('restrict'),
    check('commitment_audit_event_details_object', sql`jsonb_typeof("details") = 'object'`),
    index('commitment_audit_event_workspace_commitment_occurred_idx').on(
      table.workspaceId,
      table.commitmentId,
      table.occurredAt,
    ),
    index('commitment_audit_event_workspace_occurred_idx').on(table.workspaceId, table.occurredAt),
  ],
);

export const asyncJobStatus = commitmentosSchema.enum('async_job_status', JOB_STATUSES);

export const asyncJobFailureClass = commitmentosSchema.enum('async_job_failure_class', [
  'TRANSIENT',
  'RATE_LIMITED',
  'TIMEOUT',
  'AUTHENTICATION',
  'PERMANENT',
  'UNKNOWN',
]);

export const asyncJob = commitmentosSchema.table(
  'async_job',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    status: asyncJobStatus('status').default('PENDING').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: text('correlation_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    timeoutMs: integer('timeout_ms').default(60_000).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    failureClass: asyncJobFailureClass('failure_class'),
    errorCode: text('error_code'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('async_job_workspace_idempotency_unique').on(table.workspaceId, table.idempotencyKey),
    check('async_job_payload_object', sql`jsonb_typeof("payload") = 'object'`),
    check('async_job_idempotency_key_format', sql`"idempotency_key" ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check(
      'async_job_correlation_id_format',
      sql`"correlation_id" ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'`,
    ),
    check('async_job_attempt_count_range', sql`"attempt_count" BETWEEN 0 AND "max_attempts"`),
    check('async_job_max_attempts_range', sql`"max_attempts" BETWEEN 1 AND 10`),
    check('async_job_timeout_range', sql`"timeout_ms" BETWEEN 100 AND 900000`),
    check(
      'async_job_error_code_format',
      sql`"error_code" IS NULL OR (length("error_code") <= 96 AND "error_code" ~ '^[A-Z0-9_]+$')`,
    ),
    index('async_job_status_available_at_idx').on(table.status, table.availableAt),
    index('async_job_workspace_status_created_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const backgroundWorkerStatus = commitmentosSchema.enum('background_worker_status', [
  'READY',
  'DRAINING',
  'STOPPED',
]);

export const backgroundWorkerHeartbeat = commitmentosSchema.table(
  'background_worker_heartbeat',
  {
    workerId: text('worker_id').primaryKey(),
    queueName: text('queue_name').notNull(),
    status: backgroundWorkerStatus('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    check(
      'background_worker_error_code_length',
      sql`"last_error_code" IS NULL OR length("last_error_code") <= 96`,
    ),
    index('background_worker_queue_heartbeat_idx').on(
      table.queueName,
      table.status,
      table.lastHeartbeatAt,
    ),
  ],
);

export type { CommitmentStatus } from '../../commitments/model';
