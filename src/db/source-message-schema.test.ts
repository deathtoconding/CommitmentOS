import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { SOURCE_MESSAGE_PROVIDERS } from '../source-messages/model';
import { sourceMessage, sourceProvider } from './schema';

const config = getTableConfig(sourceMessage);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('source-message PostgreSQL schema', () => {
  it('limits provider values to the currently supported source systems', () => {
    expect(sourceProvider.enumValues).toEqual(SOURCE_MESSAGE_PROVIDERS);
    expect(sourceProvider.enumValues).toEqual(['GMAIL', 'SLACK']);
  });

  it('keeps unknown provider facts nullable while requiring workspace and record identity', () => {
    for (const name of ['id', 'workspace_id', 'created_at']) {
      expect(columns.get(name)?.notNull, `${name} should be required`).toBe(true);
    }
    for (const name of [
      'provider',
      'provider_account_id',
      'provider_message_id',
      'provider_timestamp',
      'legacy_reference',
    ]) {
      expect(columns.get(name)?.notNull, `${name} should remain nullable when unknown`).toBe(false);
    }
    expect(config.foreignKeys).toHaveLength(1);
  });

  it('deduplicates provider and legacy identities within a workspace', () => {
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      'source_message_workspace_id_unique',
      'source_message_workspace_legacy_reference_unique',
      'source_message_provider_identity_unique',
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual([
      'source_message_identity_shape',
      'source_message_provider_identifiers_nonempty',
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      'source_message_workspace_created_at_idx',
    ]);
  });

  it('does not persist message bodies, subjects, snippets, or raw headers', () => {
    const columnNames = new Set(config.columns.map((column) => column.name));
    for (const forbidden of ['body', 'raw_body', 'subject', 'snippet', 'headers', 'raw_headers']) {
      expect(columnNames.has(forbidden), `${forbidden} must not be stored by this increment`).toBe(
        false,
      );
    }
  });
});
