import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const EMAIL_VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24;
export const EMAIL_VERIFICATION_TOKEN_RESERVATION_TTL_SECONDS = 60 * 5;
export const EMAIL_VERIFICATION_CLAIM_HEADER = 'x-commitmentos-verification-claim';
const MAX_EMAIL_VERIFICATION_TOKEN_LENGTH = 4096;
const MAX_RESERVATION_ID_LENGTH = 64;

export function hashEmailVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hasValidToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_EMAIL_VERIFICATION_TOKEN_LENGTH;
}

/**
 * Atomically reserves a verification token while Better Auth verifies it.
 * Expired reservations may be reclaimed after a process crash; consumed tokens never can.
 */
export async function claimEmailVerificationToken(
  pool: Pool,
  token: string,
): Promise<string | null> {
  if (!hasValidToken(token)) return null;

  const tokenHash = hashEmailVerificationToken(token);
  const reservationId = randomUUID();

  // PostgreSQL's clock is authoritative for marker and reservation expiry across app instances.
  await pool.query(
    'DELETE FROM commitmentos.email_verification_token_use WHERE expires_at <= now()',
  );

  const result = await pool.query(
    `INSERT INTO commitmentos.email_verification_token_use AS token_use
       (token_hash, expires_at, consumed_at, use_status, reservation_id, reservation_expires_at)
     VALUES (
       $1,
       now() + ($2 * interval '1 second'),
       NULL,
       'RESERVED',
       $3,
       now() + ($4 * interval '1 second')
     )
     ON CONFLICT (token_hash) DO UPDATE SET
       expires_at = now() + ($2 * interval '1 second'),
       consumed_at = NULL,
       use_status = 'RESERVED',
       reservation_id = EXCLUDED.reservation_id,
       reservation_expires_at = now() + ($4 * interval '1 second')
     WHERE token_use.use_status = 'RESERVED'
       AND token_use.reservation_expires_at <= now()
       AND token_use.expires_at > now()
     RETURNING reservation_id`,
    [
      tokenHash,
      EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
      reservationId,
      EMAIL_VERIFICATION_TOKEN_RESERVATION_TTL_SECONDS,
    ],
  );

  return result.rows[0]?.reservation_id ?? null;
}

export async function isEmailVerificationTokenClaimed(
  pool: Pool,
  token: string,
  reservationId: string,
): Promise<boolean> {
  if (!hasValidToken(token) || !reservationId || reservationId.length > MAX_RESERVATION_ID_LENGTH) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1
     FROM commitmentos.email_verification_token_use
     WHERE token_hash = $1
       AND use_status = 'RESERVED'
       AND reservation_id = $2
       AND reservation_expires_at > now()
       AND expires_at > now()
     LIMIT 1`,
    [hashEmailVerificationToken(token), reservationId],
  );
  return result.rowCount === 1;
}

/** Finalizes a successful verification. Repeating the same finalization is idempotent. */
export async function finalizeEmailVerificationToken(
  pool: Pool,
  token: string,
  reservationId: string,
): Promise<boolean> {
  if (!hasValidToken(token) || !reservationId || reservationId.length > MAX_RESERVATION_ID_LENGTH) {
    return false;
  }

  const tokenHash = hashEmailVerificationToken(token);
  const updated = await pool.query(
    `UPDATE commitmentos.email_verification_token_use
     SET use_status = 'CONSUMED',
         consumed_at = now(),
         expires_at = now() + ($3 * interval '1 second'),
         reservation_expires_at = NULL
     WHERE token_hash = $1
       AND reservation_id = $2
       AND use_status = 'RESERVED'
       AND reservation_expires_at > now()`,
    [tokenHash, reservationId, EMAIL_VERIFICATION_TOKEN_TTL_SECONDS],
  );
  if (updated.rowCount === 1) return true;

  const existing = await pool.query(
    `SELECT 1
     FROM commitmentos.email_verification_token_use
     WHERE token_hash = $1
       AND reservation_id = $2
       AND use_status = 'CONSUMED'
       AND expires_at > now()
     LIMIT 1`,
    [tokenHash, reservationId],
  );
  return existing.rowCount === 1;
}

/** Releases only this request's pending claim after a rejected or failed verification. */
export async function releaseEmailVerificationTokenClaim(
  pool: Pool,
  token: string,
  reservationId: string,
): Promise<boolean> {
  if (!hasValidToken(token) || !reservationId || reservationId.length > MAX_RESERVATION_ID_LENGTH) {
    return false;
  }

  const result = await pool.query(
    `DELETE FROM commitmentos.email_verification_token_use
     WHERE token_hash = $1 AND reservation_id = $2 AND use_status = 'RESERVED'
     RETURNING token_hash`,
    [hashEmailVerificationToken(token), reservationId],
  );
  return result.rowCount === 1;
}
