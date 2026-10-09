import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SECRET_LENGTH = 32_768;
const envelopePattern = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/;

export function encryptIntegrationSecret(
  plaintext: string,
  key: Buffer,
  associatedData = '',
): string {
  if (key.length !== 32) throw new TypeError('Integration encryption requires a 32-byte key.');
  if (plaintext.length < 1 || plaintext.length > MAX_SECRET_LENGTH) {
    throw new TypeError('Integration secret has an invalid length.');
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptIntegrationSecret(
  envelope: string,
  key: Buffer,
  associatedData = '',
): string {
  if (key.length !== 32) throw new TypeError('Integration encryption requires a 32-byte key.');
  if (envelope.length > MAX_SECRET_LENGTH * 2) {
    throw new TypeError('Integration secret envelope has an invalid length.');
  }
  const match = envelopePattern.exec(envelope);
  if (!match) throw new TypeError('Integration secret envelope is invalid.');

  try {
    const nonce = Buffer.from(match[1], 'base64url');
    const tag = Buffer.from(match[2], 'base64url');
    const ciphertext = Buffer.from(match[3], 'base64url');
    if (nonce.length !== NONCE_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new Error('Invalid envelope component length.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    if (plaintext.length < 1 || plaintext.length > MAX_SECRET_LENGTH) {
      throw new Error('Invalid plaintext length.');
    }
    return plaintext;
  } catch {
    throw new Error('Integration secret could not be decrypted.');
  }
}
