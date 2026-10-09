import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashEmailVerificationToken } from './email-verification-token';

describe('email verification token hashing', () => {
  it('stores a deterministic SHA-256 digest instead of the bearer token', () => {
    const token = 'example.email-verification-token';
    const hash = hashEmailVerificationToken(token);

    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashEmailVerificationToken(token)).toBe(hash);
  });
});
