import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { commitment, commitmentStatus } from './schema';

const tableConfig = getTableConfig(commitment);
const columns = new Map(tableConfig.columns.map((column) => [column.name, column]));

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
      'commitment_workspace_owner_user_id_idx',
      'commitment_workspace_source_message_idx',
    ]);
  });
});
