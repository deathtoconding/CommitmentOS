import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { COMMITMENT_ALLOWED_TRANSITIONS } from './lifecycle';
import type { CommitmentStatus } from './model';

export const COMMITMENT_DEADLINE_EVALUATION_BATCH_SIZE = 100;
export const COMMITMENT_DEADLINE_EVALUATION_MAX_BATCH_SIZE = 500;

export const COMMITMENT_OVERDUE_SOURCE_STATUSES: readonly CommitmentStatus[] = (
  Object.entries(COMMITMENT_ALLOWED_TRANSITIONS) as [
    CommitmentStatus,
    readonly CommitmentStatus[],
  ][]
)
  .filter(([, targets]) => targets.includes('OVERDUE'))
  .map(([status]) => status);

export type CommitmentDeadlineEvaluationResult = {
  updatedCount: number;
  mayHaveMore: boolean;
};

function assertEvaluationInput(workspaceId: string, now: Date, batchSize: number): void {
  if (workspaceId.trim().length === 0 || workspaceId.length > 128) {
    throw new Error('A valid workspace ID is required for deadline evaluation.');
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error('A valid evaluation instant is required.');
  }
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > COMMITMENT_DEADLINE_EVALUATION_MAX_BATCH_SIZE
  ) {
    throw new Error('The deadline evaluation batch size is outside its safe bounds.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Deadline evaluation aborted.');
  }
}

/**
 * Marks only commitments whose explicit due instant has passed and whose lifecycle permits an
 * OVERDUE transition. Status updates and SYSTEM audit events commit atomically; locked rows are
 * skipped so concurrent workers can process independent workspaces/batches safely.
 */
export async function evaluateWorkspaceCommitmentDeadlines(
  pool: Pool,
  workspaceId: string,
  now = new Date(),
  batchSize = COMMITMENT_DEADLINE_EVALUATION_BATCH_SIZE,
  signal?: AbortSignal,
): Promise<CommitmentDeadlineEvaluationResult> {
  assertEvaluationInput(workspaceId, now, batchSize);
  throwIfAborted(signal);

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const due = await client.query<{ id: string; status: CommitmentStatus }>(
      `SELECT id, status
       FROM commitmentos.commitment
       WHERE workspace_id = $1
         AND due_at <= $2
         AND status = ANY($3::commitmentos.commitment_status[])
       ORDER BY due_at, id
       LIMIT $4
       FOR UPDATE SKIP LOCKED`,
      [workspaceId, now, COMMITMENT_OVERDUE_SOURCE_STATUSES, batchSize],
    );
    throwIfAborted(signal);

    if (due.rows.length === 0) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { updatedCount: 0, mayHaveMore: false };
    }

    const candidateJson = JSON.stringify(
      due.rows.map((row) => ({ commitment_id: row.id, from_status: row.status })),
    );
    const updated = await client.query<{ id: string }>(
      `UPDATE commitmentos.commitment AS commitment
       SET status = 'OVERDUE', updated_at = $3
       FROM jsonb_to_recordset($1::jsonb) AS candidate(commitment_id text, from_status text)
       WHERE commitment.workspace_id = $2
         AND commitment.id = candidate.commitment_id
         AND commitment.status = candidate.from_status::commitmentos.commitment_status
       RETURNING commitment.id`,
      [candidateJson, workspaceId, now],
    );
    throwIfAborted(signal);

    const updatedIds = updated.rows.map((row) => row.id);
    if (updatedIds.length > 0) {
      const auditJson = JSON.stringify(
        due.rows
          .filter((row) => updatedIds.includes(row.id))
          .map((row) => ({
            event_id: randomUUID(),
            commitment_id: row.id,
            from_status: row.status,
          })),
      );
      await client.query(
        `INSERT INTO commitmentos.commitment_audit_event (
           id, workspace_id, commitment_id, actor_user_id, actor_type, event_type, details, occurred_at
         )
         SELECT
           audit.event_id,
           $2,
           audit.commitment_id,
           NULL,
           'SYSTEM'::commitmentos.commitment_audit_actor_type,
           'STATUS_CHANGED'::commitmentos.commitment_audit_event_type,
           jsonb_build_object(
             'fromStatus', audit.from_status,
             'toStatus', 'OVERDUE',
             'reason', 'deadline-passed'
           ),
           $3
         FROM jsonb_to_recordset($1::jsonb) AS audit(
           event_id text,
           commitment_id text,
           from_status text
         )`,
        [auditJson, workspaceId, now],
      );
    }

    throwIfAborted(signal);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      updatedCount: updatedIds.length,
      mayHaveMore: due.rows.length === batchSize,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
