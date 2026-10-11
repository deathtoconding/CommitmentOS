import { describe, expect, it } from 'vitest';
import { getDatabaseUrl } from './config';

describe('getDatabaseUrl', () => {
  it('accepts PostgreSQL connection URLs', () => {
    const url = 'postgresql://user:secret@localhost:5432/commitmentos';

    expect(getDatabaseUrl(url)).toBe(url);
    expect(getDatabaseUrl('postgres://user@localhost/app')).toBe('postgres://user@localhost/app');
  });

  it('requires a connection URL when the supplied value is empty', () => {
    expect(() => getDatabaseUrl('')).toThrow('DATABASE_URL is required');
    expect(() => getDatabaseUrl('  ')).toThrow('DATABASE_URL is required');
  });

  it('uses DATABASE_URL when no explicit value is provided', () => {
    const previousValue = process.env.DATABASE_URL;
    const url = 'postgresql://user:secret@localhost:5432/commitmentos';

    process.env.DATABASE_URL = url;
    try {
      expect(getDatabaseUrl()).toBe(url);
    } finally {
      if (previousValue === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousValue;
      }
    }
  });

  it('rejects malformed URLs, non-PostgreSQL protocols, and missing database names', () => {
    expect(() => getDatabaseUrl('not-a-url')).toThrow('valid PostgreSQL connection URL');
    expect(() => getDatabaseUrl('https://localhost/commitmentos')).toThrow('must use postgres://');
    expect(() => getDatabaseUrl('postgresql://localhost')).toThrow('include a database name');
  });
});
