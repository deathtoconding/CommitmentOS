import { describe, expect, it } from 'vitest';
import { decryptIntegrationSecret, encryptIntegrationSecret } from './secret-crypto';

const key = Buffer.alloc(32, 17);

describe('integration secret encryption', () => {
  it('encrypts secrets with a fresh authenticated AES-256-GCM envelope', () => {
    const first = encryptIntegrationSecret('refresh-token-one', key);
    const second = encryptIntegrationSecret('refresh-token-one', key);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(first).not.toContain('refresh-token-one');
    expect(decryptIntegrationSecret(first, key)).toBe('refresh-token-one');
  });

  it('authenticates optional associated data to prevent cross-record ciphertext substitution', () => {
    const envelope = encryptIntegrationSecret('workspace-token', key, 'workspace:one:account');
    expect(decryptIntegrationSecret(envelope, key, 'workspace:one:account')).toBe(
      'workspace-token',
    );
    expect(() => decryptIntegrationSecret(envelope, key, 'workspace:two:account')).toThrow(
      'Integration secret could not be decrypted.',
    );
  });

  it('rejects tampered envelopes, wrong keys, unknown versions, and invalid lengths', () => {
    const envelope = encryptIntegrationSecret('access-token-two', key);
    const parts = envelope.split('.');
    parts[3] = `${parts[3]}A`;

    expect(() => decryptIntegrationSecret(parts.join('.'), key)).toThrow(
      'Integration secret could not be decrypted.',
    );
    expect(() => decryptIntegrationSecret(envelope, Buffer.alloc(32, 18))).toThrow(
      'Integration secret could not be decrypted.',
    );
    expect(() => decryptIntegrationSecret(envelope.replace('v1.', 'v2.'), key)).toThrow(
      'Integration secret envelope is invalid.',
    );
    expect(() => encryptIntegrationSecret('', key)).toThrow('invalid length');
    expect(() => encryptIntegrationSecret('token', Buffer.alloc(31))).toThrow('32-byte key');
  });
});
