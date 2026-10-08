import { sql } from 'drizzle-orm';
import { COMMITMENT_AUDIT_EVENT_TYPES } from '../../commitments/audit-model';
import { COMMITMENT_STATUSES } from '../../commitments/model';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
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

export const commitmentStatus = commitmentosSchema.enum('commitment_status', COMMITMENT_STATUSES);

export const commitment = commitmentosSchema.table(
  'commitment',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    // Message ingestion is modeled in a later increment; keep its external/source ID opaque here.
    sourceMessageId: text('source_message_id'),
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
    unique('commitment_workspace_id_id_unique').on(table.workspaceId, table.id),
    index('commitment_workspace_status_due_at_idx').on(
      table.workspaceId,
      table.status,
      table.dueAt,
    ),
    index('commitment_workspace_owner_user_id_idx').on(table.workspaceId, table.ownerUserId),
    index('commitment_workspace_source_message_idx').on(table.workspaceId, table.sourceMessageId),
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

export type { CommitmentStatus } from '../../commitments/model';
