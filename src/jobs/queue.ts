import { Queue } from 'bullmq';
import { isDeepStrictEqual } from 'node:util';
import Redis from 'ioredis';
import { Pool, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getJobsEnvironment, type JobsEnvironment } from './environment';
import { parseJobRequest, safeJobErrorCode, type JobKind, type JobRequest } from './model';

export type StoredJob = QueryResultRow & {
  id: string;
  workspace_id: string;
  kind: JobKind;
  status: string;
  idempotency_key: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  timeout_ms: number;
  available_at: Date;
  created_at?: Date;
};

export class JobIdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for a different background job.');
    this.name = 'JobIdempotencyConflictError';
  }
}

export class JobQueueUnavailableError extends Error {
  constructor() {
    super('Background job queue is temporarily unavailable.');
    this.name = 'JobQueueUnavailableError';
  }
}

export function createRedisConnection(environment: JobsEnvironment = getJobsEnvironment()): Redis {
  const connection = new Redis(environment.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });
  connection.on('error', (error: NodeJS.ErrnoException) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'commitmentos-jobs',
        event: 'redis_connection_error',
        code: safeJobErrorCode(error.code ?? 'REDIS_ERROR'),
      }),
    );
  });
  return connection;
}

export function createJobQueueClient(environment: JobsEnvironment = getJobsEnvironment()) {
  const connection = createRedisConnection(environment);
  const queue = new Queue(environment.queueName, {
    connection,
    prefix: environment.queuePrefix,
    defaultJobOptions: {
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600, count: 10_000 },
    },
  });
  const deadLetterQueue = new Queue(`${environment.queueName}-dead-letter`, {
    connection,
    prefix: environment.queuePrefix,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
    },
  });

  return { connection, queue, deadLetterQueue };
}

export async function enqueueJob(
  pool: Pool,
  queue: Queue,
  input: unknown,
  environment: JobsEnvironment = getJobsEnvironment(),
  createdBy?: string,
): Promise<{
  id: string;
  workspaceId: string;
  kind: JobKind;
  status: string;
  correlationId: string;
  createdAt: Date;
}> {
  const request: JobRequest = parseJobRequest(input);
  const id = randomUUID();
  const correlationId = request.correlationId ?? randomUUID();
  const inserted = await pool.query<StoredJob>(
    `INSERT INTO commitmentos.async_job (
       id, workspace_id, kind, idempotency_key, correlation_id, payload,
       max_attempts, timeout_ms, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING id, workspace_id, kind, status, idempotency_key, correlation_id,
       payload, attempt_count, max_attempts, timeout_ms, available_at, created_at`,
    [
      id,
      request.workspaceId,
      request.kind,
      request.idempotencyKey,
      correlationId,
      JSON.stringify(request.payload),
      environment.maxAttempts,
      environment.timeoutMs,
      createdBy ?? null,
    ],
  );

  let row = inserted.rows[0];
  if (!row) {
    const existing = await pool.query<StoredJob>(
      `SELECT id, workspace_id, kind, status, idempotency_key, correlation_id,
         payload, attempt_count, max_attempts, timeout_ms, available_at, created_at
       FROM commitmentos.async_job
       WHERE workspace_id = $1 AND idempotency_key = $2`,
      [request.workspaceId, request.idempotencyKey],
    );
    row = existing.rows[0];
    if (!row) throw new Error('Idempotent job row disappeared after conflict resolution.');
    if (row.kind !== request.kind || !isDeepStrictEqual(row.payload, request.payload)) {
      throw new JobIdempotencyConflictError();
    }
  }

  if (['PENDING', 'QUEUED', 'RETRYING'].includes(row.status)) {
    try {
      await queue.add(
        'process',
        { jobId: row.id, correlationId: row.correlation_id },
        {
          jobId: row.id,
          attempts: row.max_attempts,
          backoff: { type: 'exponential', delay: environment.backoffMs },
        },
      );
    } catch {
      throw new JobQueueUnavailableError();
    }

    const queued = await pool.query<StoredJob>(
      `UPDATE commitmentos.async_job
       SET status = CASE WHEN status = 'PENDING' THEN 'QUEUED'::commitmentos.async_job_status ELSE status END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, workspace_id, kind, status, idempotency_key, correlation_id,
         payload, attempt_count, max_attempts, timeout_ms, available_at, created_at`,
      [row.id],
    );
    row = queued.rows[0] ?? row;
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    correlationId: row.correlation_id,
    createdAt: (row as StoredJob & { created_at: Date }).created_at,
  };
}

export async function dispatchRecoverableJobs(
  pool: Pool,
  queue: Queue,
  environment: JobsEnvironment = getJobsEnvironment(),
  batchSize = 100,
  deadLetterQueue?: Queue,
): Promise<number> {
  const expiredLeases = await pool.query<StoredJob>(
    `UPDATE commitmentos.async_job
     SET status = CASE WHEN attempt_count >= max_attempts
       THEN 'DEAD_LETTER'::commitmentos.async_job_status
       ELSE 'RETRYING'::commitmentos.async_job_status END,
       available_at = now(),
       lease_expires_at = NULL,
       completed_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
       failure_class = 'TRANSIENT',
       error_code = 'WORKER_LEASE_EXPIRED',
       updated_at = now()
     WHERE status = 'RUNNING' AND lease_expires_at <= now()
     RETURNING id, workspace_id, kind, status, idempotency_key, correlation_id,
       payload, attempt_count, max_attempts, timeout_ms, available_at`,
  );
  for (const expired of expiredLeases.rows) {
    if (expired.status !== 'DEAD_LETTER' || !deadLetterQueue) continue;
    await deadLetterQueue
      .add(
        'failed',
        {
          jobId: expired.id,
          correlationId: expired.correlation_id,
          failureClass: 'TRANSIENT',
          errorCode: 'WORKER_LEASE_EXPIRED',
          failedAt: new Date().toISOString(),
        },
        { jobId: `failed-${expired.id}`, removeOnComplete: false, removeOnFail: false },
      )
      .catch(() => undefined);
  }

  const candidates = await pool.query<StoredJob>(
    `SELECT id, workspace_id, kind, status, idempotency_key, correlation_id,
       payload, attempt_count, max_attempts, timeout_ms, available_at
     FROM commitmentos.async_job
     WHERE status IN ('PENDING', 'QUEUED', 'RETRYING') AND available_at <= now()
     ORDER BY available_at, created_at
     LIMIT $1`,
    [batchSize],
  );
  let dispatched = 0;
  for (const row of candidates.rows) {
    await queue.add(
      'process',
      { jobId: row.id, correlationId: row.correlation_id },
      {
        jobId: row.id,
        attempts: row.max_attempts,
        backoff: { type: 'exponential', delay: environment.backoffMs },
      },
    );
    await pool.query(
      `UPDATE commitmentos.async_job
       SET status = CASE WHEN status = 'PENDING' THEN 'QUEUED'::commitmentos.async_job_status ELSE status END,
           updated_at = now()
       WHERE id = $1 AND status IN ('PENDING', 'QUEUED', 'RETRYING')`,
      [row.id],
    );
    dispatched += 1;
  }
  return dispatched;
}
