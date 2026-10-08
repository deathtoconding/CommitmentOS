import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const EMAIL_VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const MAX_EMAIL_VERIFICATION_TOKEN_LENGTH = 4096;

export function hashEmailVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function isEmailVerificationTokenConsumed(
  pool: Pool,
  token: string,
  now = new Date(),
): Promise<boolean> {
  if (!token || token.length > MAX_EMAIL_VERIFICATION_TOKEN_LENGTH) return false;

  const result = await pool.query(
    `SELECT 1
     FROM commitmentos.email_verification_token_use
     WHERE token_hash = $1 AND expires_at > $2
     LIMIT 1`,
    [hashEmailVerificationToken(token), now],
  );
  return result.rowCount === 1;
}

export async function consumeEmailVerificationToken(
  pool: Pool,
  token: string,
  now = new Date(),
): Promise<boolean> {
  if (!token || token.length > MAX_EMAIL_VERIFICATION_TOKEN_LENGTH) return false;

  const tokenHash = hashEmailVerificationToken(token);
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_SECONDS * 1000);

  // Expired JWTs can no longer verify an address, so their replay markers may be safely pruned.
  await pool.query('DELETE FROM commitmentos.email_verification_token_use WHERE expires_at <= $1', [
    now,
  ]);

  const result = await pool.query(
    `INSERT INTO commitmentos.email_verification_token_use (token_hash, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING token_hash`,
    [tokenHash, expiresAt],
  );
  return result.rowCount === 1;
}
