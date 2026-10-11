import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_AUDIT_EVENT_TYPES } from '../workspaces/audit-model';
import { workspaceAuditEvent, workspaceAuditEventType } from './schema';

const tableConfig = getTableConfig(workspaceAuditEvent);
const columns = new Map(tableConfig.columns.map((column) => [column.name, column]));

describe('workspace audit PostgreSQL schema', () => {
  it('defines the workspace and membership event types', () => {
    expect(workspaceAuditEventType.enumValues).toEqual(WORKSPACE_AUDIT_EVENT_TYPES);
  });

  it('requires tenant, actor, subject, event, metadata, and occurrence time', () => {
    for (const name of [
      'id',
      'workspace_id',
      'actor_user_id',
      'target_user_id',
      'event_type',
      'details',
      'occurred_at',
    ]) {
      expect(columns.get(name)?.notNull, `${name} should be required`).toBe(true);
    }
    expect(tableConfig.foreignKeys).toHaveLength(3);
    expect(tableConfig.checks.map((constraint) => constraint.name)).toEqual([
      'workspace_audit_event_details_object',
    ]);
  });

  it('indexes tenant-scoped history and target lookups', () => {
    expect(tableConfig.indexes.map((index) => index.config.name)).toEqual([
      'workspace_audit_event_workspace_occurred_idx',
      'workspace_audit_event_target_occurred_idx',
    ]);
  });
});
