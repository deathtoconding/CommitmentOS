import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { emailVerificationTokenUse } from './schema';

const tokenUseConfig = getTableConfig(emailVerificationTokenUse);

describe('email verification token-use PostgreSQL schema', () => {
  it('persists only token digests and models short-lived claims separately from consumption', () => {
    const columns = new Map(tokenUseConfig.columns.map((column) => [column.name, column]));
    expect(columns.has('token_hash')).toBe(true);
    expect(columns.has('use_status')).toBe(true);
    expect(columns.has('reservation_id')).toBe(true);
    expect(columns.has('reservation_expires_at')).toBe(true);
    expect(columns.has('token')).toBe(false);
    expect(columns.get('use_status')?.default).toBe('CONSUMED');
    expect(columns.get('consumed_at')?.notNull).toBe(false);
    expect(columns.get('consumed_at')?.default).toBeDefined();
    expect(tokenUseConfig.checks.map((check) => check.name)).toEqual([
      'email_verification_token_use_hash_format',
      'email_verification_token_use_status_format',
      'email_verification_token_use_reservation_consistency',
    ]);
  });
});
