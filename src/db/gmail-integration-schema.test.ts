import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  GMAIL_INTEGRATION_AUDIT_EVENT_TYPES,
  GMAIL_INTEGRATION_STATUSES,
} from '../integrations/gmail/model';
import {
  gmailIntegration,
  gmailIntegrationAuditEvent,
  gmailIntegrationAuditEventType,
  gmailIntegrationStatus,
  gmailOAuthState,
} from './schema';

const integrationConfig = getTableConfig(gmailIntegration);
const integrationColumns = new Set(integrationConfig.columns.map((column) => column.name));
const auditConfig = getTableConfig(gmailIntegrationAuditEvent);
const stateConfig = getTableConfig(gmailOAuthState);

describe('Gmail integration PostgreSQL schema', () => {
  it('limits persisted states and audit event types to explicit lifecycle transitions', () => {
    expect(gmailIntegrationStatus.enumValues).toEqual(GMAIL_INTEGRATION_STATUSES);
    expect(gmailIntegrationAuditEventType.enumValues).toEqual(GMAIL_INTEGRATION_AUDIT_EVENT_TYPES);
  });

  it('stores credentials only in an authenticated-encryption envelope, never token columns', () => {
    expect(integrationColumns.has('credentials_ciphertext')).toBe(true);
    for (const plaintextTokenColumn of [
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
    ]) {
      expect(integrationColumns.has(plaintextTokenColumn)).toBe(false);
    }
    expect(integrationConfig.checks.map((check) => check.name)).toContain(
      'gmail_integration_ciphertext_format',
    );
    expect(integrationConfig.checks.map((check) => check.name)).toContain(
      'gmail_integration_credentials_status_consistency',
    );
    expect(integrationConfig.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'gmail_integration_workspace_account_unique',
    );
  });

  it('keeps OAuth state, browser binding, and PKCE verifier workspace/user-scoped and single-use', () => {
    expect(stateConfig.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      'gmail_oauth_state_workspace_user_unique',
    );
    expect(stateConfig.columns.find((column) => column.name === 'state_hash')?.isUnique).toBe(true);
    expect(stateConfig.checks.map((check) => check.name)).toEqual([
      'gmail_oauth_state_hash_format',
      'gmail_oauth_state_browser_hash_format',
      'gmail_oauth_state_oidc_nonce_hash_format',
      'gmail_oauth_state_verifier_ciphertext_format',
    ]);
    expect(stateConfig.foreignKeys).toHaveLength(2);
  });

  it('keeps immutable audit events separate from credentials and scopes', () => {
    const auditColumns = new Set(auditConfig.columns.map((column) => column.name));
    expect(auditColumns.has('actor_user_id')).toBe(true);
    expect(auditColumns.has('workspace_id')).toBe(true);
    expect(auditColumns.has('integration_id')).toBe(true);
    expect(auditColumns.has('details')).toBe(true);
    expect(auditColumns.has('credentials_ciphertext')).toBe(false);
    expect(auditConfig.foreignKeys).toHaveLength(2);
    expect(auditConfig.checks.map((check) => check.name)).toEqual([
      'gmail_integration_audit_event_details_object',
    ]);
  });
});
