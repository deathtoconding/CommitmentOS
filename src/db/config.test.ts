import { describe, expect, it } from 'vitest';
import { getDatabaseUrl } from './config';

describe('getDatabaseUrl', () => {
  it('accepts PostgreSQL connection URLs', () => {
    const url = 'postgresql://user:secret@localhost:5432/commitmentos';

    expect(getDatabaseUrl(url)).toBe(url);
    expect(getDatabaseUrl('postgres://user@localhost/app')).toBe('postgres://user@localhost/app');
  });

  it('requires a connection URL', () => {
    expect(() => getDatabaseUrl(undefined)).toThrow('DATABASE_URL is required');
    expect(() => getDatabaseUrl('  ')).toThrow('DATABASE_URL is required');
  });

  it('rejects malformed URLs, non-PostgreSQL protocols, and missing database names', () => {
    expect(() => getDatabaseUrl('not-a-url')).toThrow('valid PostgreSQL connection URL');
    expect(() => getDatabaseUrl('https://localhost/commitmentos')).toThrow('must use postgres://');
    expect(() => getDatabaseUrl('postgresql://localhost')).toThrow('include a database name');
  });
});
