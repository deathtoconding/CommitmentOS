import { describe, expect, it } from 'vitest';
import { COMMITMENT_AUDIT_EVENT_TYPES } from '../commitments/audit-model';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  commitment,
  commitmentAuditEvent,
  commitmentAuditEventType,
  commitmentStatus,
} from './schema';

const tableConfig = getTableConfig(commitment);
const columns = new Map(tableConfig.columns.map((column) => [column.name, column]));
const auditConfig = getTableConfig(commitmentAuditEvent);
const auditColumns = new Map(auditConfig.columns.map((column) => [column.name, column]));

describe('commitment PostgreSQL schema', () => {
  it('uses the complete roadmap status enum', () => {
    expect(commitmentStatus.enumValues).toEqual([
      'DETECTED',
      'OPEN',
      'DUE_SOON',
      'WAITING',
      'BLOCKED',
      'OVERDUE',
      'COMPLETED',
      'DISMISSED',
    ]);
  });

  it('requires the workspace, commitment text, action, creator, status, and timestamps', () => {
    for (const name of [
      'id',
      'workspace_id',
      'commitment_text',
      'normalized_action',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.get(name)?.notNull, `${name} should be required`).toBe(true);
    }
  });

  it('leaves unknown owner, source, counterparty, deadline, confidence, and evidence nullable', () => {
    for (const name of [
      'owner_user_id',
      'source_message_id',
      'counterparty_name',
      'counterparty_email',
      'due_at',
      'due_timezone',
      'confidence_score',
      'source_excerpt',
      'completion_evidence',
      'completed_at',
    ]) {
      expect(columns.get(name)?.notNull, `${name} should be nullable`).toBe(false);
    }
  });

  it('defines foreign keys, validation constraints, and workspace-scoped indexes', () => {
    expect(tableConfig.foreignKeys).toHaveLength(3);
    expect(tableConfig.checks.map((constraint) => constraint.name)).toEqual([
      'commitment_text_nonempty',
      'commitment_action_nonempty',
      'commitment_confidence_score_range',
    ]);
    expect(tableConfig.indexes.map((index) => index.config.name)).toEqual([
      'commitment_workspace_status_due_at_idx',
      'commitment_workspace_created_at_id_idx',
      'commitment_workspace_owner_user_id_idx',
      'commitment_workspace_source_message_idx',
    ]);
    expect(tableConfig.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'commitment_workspace_id_id_unique',
    );
  });
});

describe('commitment audit event PostgreSQL schema', () => {
  it('defines the required current and forward-compatible event types', () => {
    expect(commitmentAuditEventType.enumValues).toEqual(COMMITMENT_AUDIT_EVENT_TYPES);
  });

  it('requires actor, tenant scope, commitment, event type, details, and occurrence time', () => {
    for (const name of [
      'id',
      'workspace_id',
      'commitment_id',
      'actor_user_id',
      'event_type',
      'details',
      'occurred_at',
    ]) {
      expect(auditColumns.get(name)?.notNull, `${name} should be required`).toBe(true);
    }
    expect(auditConfig.foreignKeys).toHaveLength(3);
    expect(auditConfig.checks.map((constraint) => constraint.name)).toEqual([
      'commitment_audit_event_details_object',
    ]);
  });

  it('indexes audit history by workspace and commitment', () => {
    expect(auditConfig.indexes.map((index) => index.config.name)).toEqual([
      'commitment_audit_event_workspace_commitment_occurred_idx',
      'commitment_audit_event_workspace_occurred_idx',
    ]);
  });
});
