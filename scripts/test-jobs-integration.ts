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
import { PermanentJobError, RateLimitedJobError, RetryableJobError } from '../src/jobs/model';
import type { JobProcessorMap } from '../src/jobs/worker-core';
import { getJobReadiness } from '../src/jobs/readiness';
import { startJobWorker } from '../src/jobs/worker-core';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL before running the jobs integration checks.');
const environmentBase = getJobsEnvironment();
const environment: JobsEnvironment = {
  ...environmentBase,
  workerConcurrency: 3,
  maxAttempts: 3,
  backoffMs: 250,
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
const exhaustedProbeId = randomUUID();
const rateLimitedProbeId = randomUUID();
const timeoutProbeId = randomUUID();
const pendingProbeId = randomUUID();
const restartProbeId = randomUUID();
const probeAttempts = new Map<string, number>();
const workerLogs: string[] = [];
const originalConsoleInfo = console.info;
let worker: Awaited<ReturnType<typeof startJobWorker>> | undefined;
const workerIds = new Set([workerId]);
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

async function waitForRetrySchedule(jobId: string) {
  if (!worker) throw new Error('The integration worker is not running.');
  const activeWorker = worker;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      status: string;
      available_at: Date;
      updated_at: Date;
    }>('SELECT status, available_at, updated_at FROM commitmentos.async_job WHERE id = $1', [
      jobId,
    ]);
    const row = result.rows[0];
    const queued = await activeWorker.queue.getJob(jobId);
    if (row?.status === 'RETRYING' && queued && (await queued.getState()) === 'delayed') {
      return { row, queued };
    }
    await delay(5);
  }
  throw new Error(`Job ${jobId} did not enter a durable and queued retry delay.`);
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

async function waitForQueueJob(queueJobId: string, expectedState = 'completed') {
  if (!worker) throw new Error('The integration worker is not running.');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const queued = await worker.queue.getJob(queueJobId);
    if (queued && (await queued.getState()) === expectedState) return queued;
    await delay(25);
  }
  throw new Error(`Queue job ${queueJobId} did not reach ${expectedState}.`);
}

function probeInput(idempotencyKey: string, probeId: string) {
  return {
    workspaceId,
    kind: 'PLATFORM_PROBE' as const,
    idempotencyKey,
    payload: { probeId },
  };
}

const logRedactionMarker = 'synthetic-provider-secret-must-not-be-logged';
const processors: JobProcessorMap = {
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
    if (probeId === rateLimitedProbeId && attempt === 1) {
      throw new RateLimitedJobError('Synthetic provider rate limit.', 'HTTP_429', 1_000);
    }
    if (probeId === exhaustedProbeId) {
      throw new RetryableJobError(`Retry exhaustion ${logRedactionMarker}`, 'TEST_TRANSIENT');
    }
    if (probeId === permanentProbeId) {
      throw new PermanentJobError(
        `Injected permanent failure ${logRedactionMarker}`,
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
    const result = await pool.query('SELECT 1 FROM commitmentos.workspace WHERE id = $1 LIMIT 1', [
      targetWorkspaceId,
    ]);
    if (result.rowCount !== 1) {
      throw new PermanentJobError('The workspace fixture is missing.', 'WORKSPACE_NOT_FOUND');
    }
  },
};

function startIntegrationWorker(id: string) {
  return startJobWorker({ pool, workerId: id, environment, processors });
}

try {
  await pool.query('INSERT INTO commitmentos.workspace (id, name) VALUES ($1, $2)', [
    workspaceId,
    'Jobs integration fixture',
  ]);

  console.info = (...data) => {
    workerLogs.push(data.map((value) => String(value)).join(' '));
  };
  worker = await startIntegrationWorker(workerId);

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

  const duplicateDeliveryId = `duplicate-${randomUUID()}`;
  createdJobIds.add(duplicateDeliveryId);
  await worker.queue.add(
    'process',
    { jobId: firstEnqueue.id, correlationId: firstEnqueue.correlationId },
    { jobId: duplicateDeliveryId, attempts: 1 },
  );
  await waitForQueueJob(duplicateDeliveryId);
  const afterDuplicateDelivery = await waitForJob(firstEnqueue.id, 'SUCCEEDED');
  assert.equal(afterDuplicateDelivery.attempt_count, 1);
  assert.equal(probeAttempts.get(request.payload.probeId), 1);

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
  const transientRetrySchedule = await waitForRetrySchedule(retryJob.id);
  const persistedTransientDelayMs =
    transientRetrySchedule.row.available_at.getTime() -
    transientRetrySchedule.row.updated_at.getTime();
  assert.ok(
    persistedTransientDelayMs >= environment.backoffMs / 2 &&
      persistedTransientDelayMs <= environment.backoffMs,
    'Transient retry delays must use equal jitter within the configured exponential window.',
  );
  assert.equal(
    transientRetrySchedule.queued.delay,
    persistedTransientDelayMs,
    'BullMQ and PostgreSQL must use the same sampled transient retry delay.',
  );
  const retried = await waitForJob(retryJob.id, 'SUCCEEDED');
  assert.equal(retried.attempt_count, 2);
  assert.equal(retried.max_attempts, environment.maxAttempts);
  assert.equal(retried.error_code, null, 'A successful retry should clear the last failure code.');

  const rateLimitedJob = await enqueueJob(
    pool,
    worker.queue,
    probeInput(`rate-limited:${randomUUID()}`, rateLimitedProbeId),
    environment,
  );
  createdJobIds.add(rateLimitedJob.id);
  const rateLimitRetrySchedule = await waitForRetrySchedule(rateLimitedJob.id);
  const persistedRateLimitDelayMs =
    rateLimitRetrySchedule.row.available_at.getTime() -
    rateLimitRetrySchedule.row.updated_at.getTime();
  assert.equal(persistedRateLimitDelayMs, 1_000);
  assert.equal(
    rateLimitRetrySchedule.queued.delay,
    persistedRateLimitDelayMs,
    'BullMQ and PostgreSQL must use the same bounded provider retry hint.',
  );
  const rateLimitRetried = await waitForJob(rateLimitedJob.id, 'SUCCEEDED');
  assert.equal(rateLimitRetried.attempt_count, 2);

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

  const exhaustedJob = await enqueueJob(
    pool,
    worker.queue,
    probeInput(`exhausted:${randomUUID()}`, exhaustedProbeId),
    environment,
  );
  createdJobIds.add(exhaustedJob.id);
  const exhausted = await waitForJob(exhaustedJob.id, 'DEAD_LETTER');
  assert.equal(exhausted.attempt_count, environment.maxAttempts);
  assert.equal(exhausted.failure_class, 'TRANSIENT');
  assert.equal(exhausted.error_code, 'TEST_TRANSIENT');
  const exhaustedDeadLetterEntry = await waitForDeadLetter(exhaustedJob.id);
  assert.equal(exhaustedDeadLetterEntry.data.failureClass, 'TRANSIENT');
  assert.equal(exhaustedDeadLetterEntry.data.errorCode, 'TEST_TRANSIENT');

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

  const structuredSuccessLog = workerLogs.find(
    (line) => line.includes('"event":"job_succeeded"') && line.includes(firstEnqueue.id),
  );
  assert.ok(structuredSuccessLog?.includes(firstEnqueue.correlationId));
  assert.equal(
    workerLogs.join('\n').includes(logRedactionMarker),
    false,
    'Structured worker logs must not contain raw processor error messages.',
  );
  assert.equal(
    workerLogs.join('\n').includes(request.payload.probeId),
    false,
    'Structured worker logs must not contain job payloads.',
  );

  const failedTransportJobId = randomUUID();
  const failedTransportCorrelationId = randomUUID();
  const failedTransportProbeId = randomUUID();
  await pool.query(
    `INSERT INTO commitmentos.async_job (
       id, workspace_id, kind, idempotency_key, correlation_id, payload,
       max_attempts, timeout_ms, status
     ) VALUES ($1, $2, 'PLATFORM_PROBE', $3, $4, $5::jsonb, $6, $7, 'PENDING')`,
    [
      failedTransportJobId,
      workspaceId,
      `transport-recovery:${randomUUID()}`,
      failedTransportCorrelationId,
      JSON.stringify({ probeId: failedTransportProbeId }),
      environment.maxAttempts,
      environment.timeoutMs,
    ],
  );
  createdJobIds.add(failedTransportJobId);
  await worker.queue.add('process', { malformed: 'message' } as never, {
    jobId: failedTransportJobId,
    attempts: 1,
  });
  await waitForQueueJob(failedTransportJobId, 'failed');
  const pendingAfterTransportFailure = await pool.query(
    'SELECT status, attempt_count FROM commitmentos.async_job WHERE id = $1',
    [failedTransportJobId],
  );
  assert.deepEqual(pendingAfterTransportFailure.rows[0], { status: 'PENDING', attempt_count: 0 });
  assert.ok(
    (await dispatchRecoverableJobs(pool, worker.queue, environment)) >= 1,
    'The outbox must replace a failed Redis delivery while leaving the durable job pending.',
  );
  const transportRecovered = await waitForJob(failedTransportJobId, 'SUCCEEDED');
  assert.equal(transportRecovered.attempt_count, 1);
  assert.equal(probeAttempts.get(failedTransportProbeId), 1);

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

  await worker.close();
  worker = undefined;
  const stoppedReadiness = await getJobReadiness(pool, environment);
  assert.deepEqual(stoppedReadiness, {
    ready: false,
    dependencies: { postgres: 'ready', redis: 'ready', worker: 'not_ready' },
  });

  const restartJobId = randomUUID();
  const restartCorrelationId = randomUUID();
  await pool.query(
    `INSERT INTO commitmentos.async_job (
       id, workspace_id, kind, idempotency_key, correlation_id, payload,
       attempt_count, max_attempts, timeout_ms, status, started_at, lease_expires_at
     ) VALUES (
       $1, $2, 'PLATFORM_PROBE', $3, $4, $5::jsonb,
       1, $6, $7, 'RUNNING', now() - interval '2 seconds', now() - interval '1 second'
     )`,
    [
      restartJobId,
      workspaceId,
      `restart:${randomUUID()}`,
      restartCorrelationId,
      JSON.stringify({ probeId: restartProbeId }),
      environment.maxAttempts,
      environment.timeoutMs,
    ],
  );
  createdJobIds.add(restartJobId);
  const restartedWorkerId = `integration-restart-${randomUUID()}`;
  workerIds.add(restartedWorkerId);
  worker = await startIntegrationWorker(restartedWorkerId);
  const restartedReadiness = await getJobReadiness(pool, environment);
  assert.equal(restartedReadiness.ready, true);
  const restartedJob = await waitForJob(restartJobId, 'SUCCEEDED');
  assert.equal(restartedJob.attempt_count, 2);
  assert.equal(restartedJob.correlation_id, restartCorrelationId);
  assert.equal(probeAttempts.get(restartProbeId), 1);

  console.log(
    'PostgreSQL and Redis/BullMQ job integration checks passed: idempotency, duplicate delivery, jittered retries, retry exhaustion, timeout cancellation, permanent dead-letter, worker restart/outbox recovery, redacted logs, and readiness.',
  );
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : 'unknown';
  const message = error instanceof Error ? error.message : 'Unknown integration test failure.';
  const causeMessage =
    error instanceof Error && error.cause instanceof Error
      ? `; caused by ${error.cause.name}: ${error.cause.message}`
      : '';
  const safeMessage = [databaseUrl, environment.redisUrl]
    .filter(Boolean)
    .reduce(
      (result, secret) => result.replaceAll(secret, '[redacted]'),
      `${message}${causeMessage}`,
    );
  const diagnostic = `Background jobs integration checks failed (${code}): ${safeMessage}`;
  console.error(diagnostic);
  const escapedDiagnostic = diagnostic
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  process.stdout.write(`::error title=Background jobs integration failure::${escapedDiagnostic}\n`);
  process.exitCode = 1;
} finally {
  console.info = originalConsoleInfo;
  if (worker) {
    const deadLetterJobs = await Promise.all(
      [...createdJobIds].map((jobId) =>
        worker?.deadLetterQueue.getJob(`failed-${jobId}`).catch(() => undefined),
      ),
    );
    for (const job of deadLetterJobs) {
      if (job) await job.remove().catch(() => undefined);
    }
    const queueJobs = await Promise.all(
      [...createdJobIds].map((jobId) => worker?.queue.getJob(jobId).catch(() => undefined)),
    );
    for (const job of queueJobs) {
      if (job) await job.remove().catch(() => undefined);
    }
    await worker.close().catch(() => undefined);
  }
  await pool
    .query('DELETE FROM commitmentos.async_job WHERE workspace_id = $1', [workspaceId])
    .catch(() => undefined);
  await pool
    .query(
      'DELETE FROM commitmentos.background_worker_heartbeat WHERE worker_id = ANY($1::text[])',
      [[...workerIds]],
    )
    .catch(() => undefined);
  await pool
    .query('DELETE FROM commitmentos.workspace WHERE id = $1', [workspaceId])
    .catch(() => undefined);
  await pool.end();
}
