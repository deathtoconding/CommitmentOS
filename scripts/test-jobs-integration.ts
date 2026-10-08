import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { getJobsEnvironment, type JobsEnvironment } from '../src/jobs/environment';
import {
  enqueueJob,
  dispatchRecoverableJobs,
  JobIdempotencyConflictError,
} from '../src/jobs/queue';
import { PermanentJobError, RetryableJobError } from '../src/jobs/model';
import { getJobReadiness } from '../src/jobs/readiness';
import { startJobWorker } from '../src/jobs/worker-core';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL before running the jobs integration checks.');
const environmentBase = getJobsEnvironment();
const environment: JobsEnvironment = {
  ...environmentBase,
  workerConcurrency: 3,
  maxAttempts: 3,
  backoffMs: 25,
  timeoutMs: 1_000,
  heartbeatIntervalMs: 1_000,
  heartbeatStaleMs: 5_000,
  recoveryIntervalMs: 1_000,
};
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-jobs-integration-test',
});
const workspaceId = randomUUID();
const workerId = `integration-${randomUUID()}`;
const transientProbeId = randomUUID();
const permanentProbeId = randomUUID();
const timeoutProbeId = randomUUID();
const pendingProbeId = randomUUID();
const probeAttempts = new Map<string, number>();
let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
const createdJobIds = new Set<string>();

async function waitForJob(jobId: string, expectedStatus: 'SUCCEEDED' | 'DEAD_LETTER') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT id, status, attempt_count, max_attempts, failure_class, error_code,
         correlation_id, completed_at, payload
       FROM commitmentos.async_job WHERE id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (row?.status === expectedStatus) return row;
    await delay(50);
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expectedStatus}.`);
}

async function waitForDeadLetter(jobId: string) {
  if (!worker) throw new Error('The integration worker is not running.');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entry = await worker.deadLetterQueue.getJob(`failed-${jobId}`);
    if (entry) return entry;
    await delay(25);
  }
  throw new Error(`Dead-letter queue did not record job ${jobId}.`);
}

function probeInput(idempotencyKey: string, probeId: string) {
  return {
    workspaceId,
    kind: 'PLATFORM_PROBE' as const,
    idempotencyKey,
    payload: { probeId },
  };
}

try {
  await pool.query('INSERT INTO commitmentos.workspace (id, name) VALUES ($1, $2)', [
    workspaceId,
    'Jobs integration fixture',
  ]);

  worker = await startJobWorker({
    pool,
    workerId,
    environment,
    processors: {
      PLATFORM_PROBE: async ({ workspaceId: targetWorkspaceId, payload, signal }) => {
        const probeId = String(payload.probeId);
        const attempt = (probeAttempts.get(probeId) ?? 0) + 1;
        probeAttempts.set(probeId, attempt);
        if (signal.aborted) throw signal.reason;
        if (probeId === transientProbeId && attempt === 1) {
          throw new RetryableJobError(
            'Injected retry path for infrastructure testing.',
            'TEST_TRANSIENT',
          );
        }
        if (probeId === permanentProbeId) {
          throw new PermanentJobError(
            'Injected permanent failure for infrastructure testing.',
            'TEST_PERMANENT',
          );
        }
        if (probeId === timeoutProbeId) {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        if (signal.aborted) throw signal.reason;
        const result = await pool.query(
          'SELECT 1 FROM commitmentos.workspace WHERE id = $1 LIMIT 1',
          [targetWorkspaceId],
        );
        if (result.rowCount !== 1) {
          throw new PermanentJobError('The workspace fixture is missing.', 'WORKSPACE_NOT_FOUND');
        }
      },
    },
  });

  const readiness = await getJobReadiness(pool, environment);
  assert.deepEqual(readiness, {
    ready: true,
    dependencies: { postgres: 'ready', redis: 'ready', worker: 'ready' },
  });

  const idempotencyKey = `integration:${randomUUID()}`;
  const request = probeInput(idempotencyKey, randomUUID());
  const [firstEnqueue, duplicateEnqueue] = await Promise.all([
    enqueueJob(pool, worker.queue, request, environment),
    enqueueJob(pool, worker.queue, request, environment),
  ]);
  createdJobIds.add(firstEnqueue.id);
  assert.equal(firstEnqueue.id, duplicateEnqueue.id);
  assert.equal(firstEnqueue.correlationId, duplicateEnqueue.correlationId);
  const succeeded = await waitForJob(firstEnqueue.id, 'SUCCEEDED');
  assert.equal(succeeded.attempt_count, 1);
  assert.equal(succeeded.error_code, null);
  assert.equal(succeeded.payload.probeId, request.payload.probeId);

  await assert.rejects(
    enqueueJob(pool, worker.queue, probeInput(idempotencyKey, randomUUID()), environment),
    JobIdempotencyConflictError,
    'Reusing an idempotency key for different work must conflict.',
  );

  const retryJob = await enqueueJob(
    pool,
    worker.queue,
    probeInput(`retry:${randomUUID()}`, transientProbeId),
    environment,
  );
  createdJobIds.add(retryJob.id);
  const retried = await waitForJob(retryJob.id, 'SUCCEEDED');
  assert.equal(retried.attempt_count, 2);
  assert.equal(retried.max_attempts, environment.maxAttempts);
  assert.equal(retried.error_code, null, 'A successful retry should clear the last failure code.');

  const permanentJob = await enqueueJob(
    pool,
    worker.queue,
    probeInput(`permanent:${randomUUID()}`, permanentProbeId),
    environment,
  );
  createdJobIds.add(permanentJob.id);
  const deadLettered = await waitForJob(permanentJob.id, 'DEAD_LETTER');
  assert.equal(deadLettered.attempt_count, 1);
  assert.equal(deadLettered.failure_class, 'PERMANENT');
  assert.equal(deadLettered.error_code, 'TEST_PERMANENT');
  assert.ok(deadLettered.completed_at instanceof Date);
  const deadLetterEntry = await waitForDeadLetter(permanentJob.id);
  assert.ok(
    deadLetterEntry,
    'Permanent failures must be recorded in the BullMQ dead-letter queue.',
  );
  assert.deepEqual(deadLetterEntry.data, {
    jobId: permanentJob.id,
    correlationId: permanentJob.correlationId,
    failureClass: 'PERMANENT',
    errorCode: 'TEST_PERMANENT',
    failedAt: deadLetterEntry.data.failedAt,
  });
  assert.equal('payload' in deadLetterEntry.data, false);

  const timeoutJob = await enqueueJob(
    pool,
    worker.queue,
    probeInput(`timeout:${randomUUID()}`, timeoutProbeId),
    environment,
  );
  createdJobIds.add(timeoutJob.id);
  const timedOut = await waitForJob(timeoutJob.id, 'DEAD_LETTER');
  assert.equal(timedOut.attempt_count, environment.maxAttempts);
  assert.equal(timedOut.failure_class, 'TIMEOUT');
  assert.equal(timedOut.error_code, 'JOB_TIMEOUT');

  const pendingJobId = randomUUID();
  const pendingCorrelationId = randomUUID();
  await pool.query(
    `INSERT INTO commitmentos.async_job (
       id, workspace_id, kind, idempotency_key, correlation_id, payload,
       max_attempts, timeout_ms, status
     ) VALUES ($1, $2, 'PLATFORM_PROBE', $3, $4, $5::jsonb, $6, $7, 'PENDING')`,
    [
      pendingJobId,
      workspaceId,
      `outbox:${randomUUID()}`,
      pendingCorrelationId,
      JSON.stringify({ probeId: pendingProbeId }),
      environment.maxAttempts,
      environment.timeoutMs,
    ],
  );
  createdJobIds.add(pendingJobId);
  assert.ok(
    (await dispatchRecoverableJobs(pool, worker.queue, environment)) >= 1,
    'The outbox dispatcher should publish durable pending rows to Redis.',
  );
  const recovered = await waitForJob(pendingJobId, 'SUCCEEDED');
  assert.equal(recovered.attempt_count, 1);
  assert.equal(recovered.correlation_id, pendingCorrelationId);

  console.log(
    'PostgreSQL and Redis/BullMQ job integration checks passed: durable enqueue/outbox recovery, idempotency, correlation, retries/backoff, timeout, dead-letter, and worker readiness.',
  );
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : 'unknown';
  const message = error instanceof Error ? error.message : 'Unknown integration test failure.';
  const safeMessage = [databaseUrl, environment.redisUrl]
    .filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, '[redacted]'), message);
  const diagnostic = `Background jobs integration checks failed (${code}): ${safeMessage}`;
  console.error(diagnostic);
  const escapedDiagnostic = diagnostic
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  process.stdout.write(`::error title=Background jobs integration failure::${escapedDiagnostic}\n`);
  process.exitCode = 1;
} finally {
  if (worker) {
    const deadLetterJobs = await Promise.all(
      [...createdJobIds].map((jobId) =>
        worker?.deadLetterQueue.getJob(`failed-${jobId}`).catch(() => undefined),
      ),
    );
    for (const job of deadLetterJobs) {
      if (job) await job.remove().catch(() => undefined);
    }
    await worker.close().catch(() => undefined);
  }
  await pool
    .query('DELETE FROM commitmentos.async_job WHERE workspace_id = $1', [workspaceId])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM commitmentos.background_worker_heartbeat WHERE worker_id = $1', [workerId])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM commitmentos.workspace WHERE id = $1', [workspaceId])
    .catch(() => undefined);
  await pool.end();
}
