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
import { evaluateWorkspaceCommitmentDeadlines } from '../src/commitments/deadline-evaluation';

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
  deadlineSweepIntervalMs: 60_000,
};
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: 'commitmentos-jobs-integration-test',
});
const workspaceId = randomUUID();
const secondWorkspaceId = randomUUID();
const isolationWorkspaceId = randomUUID();
const deadlineCreatorUserId = randomUUID();
const workspaceIds = [workspaceId, secondWorkspaceId, isolationWorkspaceId];
const pastDeadline = new Date(Date.now() - 60_000);
const futureDeadline = new Date(Date.now() + 24 * 60 * 60 * 1_000);
const deadlineFixtures = [
  { id: randomUUID(), workspaceId, status: 'OPEN', dueAt: pastDeadline, shouldOverdue: true },
  { id: randomUUID(), workspaceId, status: 'DUE_SOON', dueAt: pastDeadline, shouldOverdue: true },
  { id: randomUUID(), workspaceId, status: 'WAITING', dueAt: pastDeadline, shouldOverdue: true },
  { id: randomUUID(), workspaceId, status: 'BLOCKED', dueAt: pastDeadline, shouldOverdue: true },
  { id: randomUUID(), workspaceId, status: 'DETECTED', dueAt: pastDeadline, shouldOverdue: false },
  { id: randomUUID(), workspaceId, status: 'OPEN', dueAt: futureDeadline, shouldOverdue: false },
  { id: randomUUID(), workspaceId, status: 'OPEN', dueAt: null, shouldOverdue: false },
  {
    id: randomUUID(),
    workspaceId: secondWorkspaceId,
    status: 'OPEN',
    dueAt: pastDeadline,
    shouldOverdue: true,
  },
];
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

async function waitForDeadlineSweepJob(targetWorkspaceId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM commitmentos.async_job
       WHERE workspace_id = $1 AND kind = 'COMMITMENT_DEADLINE_SWEEP'
       ORDER BY created_at DESC LIMIT 1`,
      [targetWorkspaceId],
    );
    if (result.rows[0]) return result.rows[0].id;
    await delay(25);
  }
  throw new Error('The deadline scheduler did not create a durable workspace sweep job.');
}

async function waitForCommitmentStatus(commitmentId: string, expectedStatus: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM commitmentos.commitment WHERE id = $1',
      [commitmentId],
    );
    if (result.rows[0]?.status === expectedStatus) return;
    await delay(25);
  }
  throw new Error(`Commitment did not reach expected status ${expectedStatus}.`);
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

function isCheckConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23514';
}

try {
  for (const [id, name] of [
    [workspaceId, 'Jobs integration fixture'],
    [secondWorkspaceId, 'Deadline tenant fixture'],
    [isolationWorkspaceId, 'Deadline isolation fixture'],
  ]) {
    await pool.query('INSERT INTO commitmentos.workspace (id, name) VALUES ($1, $2)', [id, name]);
  }
  await pool.query(
    `INSERT INTO commitmentos.user (id, name, email, email_verified)
     VALUES ($1, 'Deadline integration actor', $2, true)`,
    [deadlineCreatorUserId, `deadline-${deadlineCreatorUserId}@integration.test`],
  );
  for (const fixture of deadlineFixtures) {
    await pool.query(
      `INSERT INTO commitmentos.commitment (
         id, workspace_id, commitment_text, normalized_action, status, due_at, created_by
       ) VALUES ($1, $2, $3, $4, $5::commitmentos.commitment_status, $6, $7)`,
      [
        fixture.id,
        fixture.workspaceId,
        `Synthetic deadline integration commitment ${fixture.id}`,
        `Deadline integration ${fixture.status}`,
        fixture.status,
        fixture.dueAt,
        deadlineCreatorUserId,
      ],
    );
  }

  console.info = (...data) => {
    workerLogs.push(data.map((value) => String(value)).join(' '));
  };
  worker = await startIntegrationWorker(workerId);

  const readiness = await getJobReadiness(pool, environment);
  assert.deepEqual(readiness, {
    ready: true,
    dependencies: { postgres: 'ready', redis: 'ready', worker: 'ready' },
  });

  for (const targetWorkspaceId of [workspaceId, secondWorkspaceId]) {
    const deadlineJobId = await waitForDeadlineSweepJob(targetWorkspaceId);
    createdJobIds.add(deadlineJobId);
    const deadlineJob = await waitForJob(deadlineJobId, 'SUCCEEDED');
    assert.equal(deadlineJob.attempt_count, 1);
  }
  for (const fixture of deadlineFixtures) {
    await waitForCommitmentStatus(fixture.id, fixture.shouldOverdue ? 'OVERDUE' : fixture.status);
  }
  const eligibleDeadlineIds = deadlineFixtures
    .filter((fixture) => fixture.shouldOverdue)
    .map((fixture) => fixture.id);
  const deadlineAuditEvents = await pool.query<{
    workspace_id: string;
    commitment_id: string;
    actor_user_id: string | null;
    actor_type: string;
    event_type: string;
    details: Record<string, unknown>;
  }>(
    `SELECT workspace_id, commitment_id, actor_user_id, actor_type, event_type, details
     FROM commitmentos.commitment_audit_event
     WHERE commitment_id = ANY($1::text[])`,
    [eligibleDeadlineIds],
  );
  assert.equal(deadlineAuditEvents.rows.length, eligibleDeadlineIds.length);
  const eligibleAuditFixture = deadlineFixtures.find((fixture) => fixture.shouldOverdue);
  assert.ok(eligibleAuditFixture);
  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.commitment_audit_event (
         id, workspace_id, commitment_id, actor_user_id, actor_type, event_type, details
       ) VALUES ($1, $2, $3, $4, 'SYSTEM', 'STATUS_CHANGED', '{}'::jsonb)`,
      [
        randomUUID(),
        eligibleAuditFixture.workspaceId,
        eligibleAuditFixture.id,
        deadlineCreatorUserId,
      ],
    ),
    isCheckConstraintViolation,
    'SYSTEM audit events must not accept a user ID.',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commitmentos.commitment_audit_event (
         id, workspace_id, commitment_id, actor_user_id, actor_type, event_type, details
       ) VALUES ($1, $2, $3, NULL, 'USER', 'STATUS_CHANGED', '{}'::jsonb)`,
      [randomUUID(), eligibleAuditFixture.workspaceId, eligibleAuditFixture.id],
    ),
    isCheckConstraintViolation,
    'USER audit events must include a user ID.',
  );
  for (const event of deadlineAuditEvents.rows) {
    const fixture = deadlineFixtures.find((candidate) => candidate.id === event.commitment_id);
    assert.ok(fixture);
    assert.equal(event.workspace_id, fixture.workspaceId);
    assert.equal(event.actor_user_id, null);
    assert.equal(event.actor_type, 'SYSTEM');
    assert.equal(event.event_type, 'STATUS_CHANGED');
    assert.deepEqual(event.details, {
      fromStatus: fixture.status,
      toStatus: 'OVERDUE',
      reason: 'deadline-passed',
    });
  }
  const excludedDeadlineAudit = await pool.query<{ count: string }>(
    'SELECT count(*) FROM commitmentos.commitment_audit_event WHERE commitment_id = ANY($1::text[])',
    [deadlineFixtures.filter((fixture) => !fixture.shouldOverdue).map((fixture) => fixture.id)],
  );
  assert.equal(excludedDeadlineAudit.rows[0]?.count, '0');

  const batchDeadlineIds = [randomUUID(), randomUUID()];
  for (const id of batchDeadlineIds) {
    await pool.query(
      `INSERT INTO commitmentos.commitment (
         id, workspace_id, commitment_text, normalized_action, status, due_at, created_by
       ) VALUES ($1, $2, $3, $4, 'OPEN', $5, $6)`,
      [
        id,
        isolationWorkspaceId,
        `Synthetic batch deadline fixture ${id}`,
        'Batch deadline',
        pastDeadline,
        deadlineCreatorUserId,
      ],
    );
  }
  const wrongWorkspaceEvaluation = await evaluateWorkspaceCommitmentDeadlines(
    pool,
    workspaceId,
    new Date(),
  );
  assert.deepEqual(wrongWorkspaceEvaluation, { updatedCount: 0, mayHaveMore: false });
  const untouchedTenant = await pool.query<{ status: string }>(
    'SELECT status FROM commitmentos.commitment WHERE id = ANY($1::text[])',
    [batchDeadlineIds],
  );
  assert.deepEqual(
    untouchedTenant.rows.map((row) => row.status),
    ['OPEN', 'OPEN'],
  );
  const firstDeadlineBatch = await evaluateWorkspaceCommitmentDeadlines(
    pool,
    isolationWorkspaceId,
    new Date(),
    1,
  );
  const secondDeadlineBatch = await evaluateWorkspaceCommitmentDeadlines(
    pool,
    isolationWorkspaceId,
    new Date(),
    1,
  );
  assert.deepEqual(firstDeadlineBatch, { updatedCount: 1, mayHaveMore: true });
  assert.deepEqual(secondDeadlineBatch, { updatedCount: 1, mayHaveMore: true });
  const exhaustedDeadlineBatch = await evaluateWorkspaceCommitmentDeadlines(
    pool,
    isolationWorkspaceId,
    new Date(),
    1,
  );
  assert.deepEqual(exhaustedDeadlineBatch, { updatedCount: 0, mayHaveMore: false });
  await Promise.all(batchDeadlineIds.map((id) => waitForCommitmentStatus(id, 'OVERDUE')));
  const batchDeadlineAudits = await pool.query<{
    commitment_id: string;
    workspace_id: string;
    actor_user_id: string | null;
    actor_type: string;
    details: Record<string, unknown>;
  }>(
    `SELECT commitment_id, workspace_id, actor_user_id, actor_type, details
     FROM commitmentos.commitment_audit_event
     WHERE commitment_id = ANY($1::text[])`,
    [batchDeadlineIds],
  );
  assert.equal(batchDeadlineAudits.rows.length, batchDeadlineIds.length);
  for (const event of batchDeadlineAudits.rows) {
    assert.equal(event.workspace_id, isolationWorkspaceId);
    assert.equal(event.actor_user_id, null);
    assert.equal(event.actor_type, 'SYSTEM');
    assert.deepEqual(event.details, {
      fromStatus: 'OPEN',
      toStatus: 'OVERDUE',
      reason: 'deadline-passed',
    });
  }

  const atomicDeadlineId = randomUUID();
  await pool.query(
    `INSERT INTO commitmentos.commitment (
       id, workspace_id, commitment_text, normalized_action, status, due_at, created_by
     ) VALUES ($1, $2, $3, $4, 'OPEN', $5, $6)`,
    [
      atomicDeadlineId,
      isolationWorkspaceId,
      `Synthetic atomic deadline fixture ${atomicDeadlineId}`,
      'Atomic deadline',
      pastDeadline,
      deadlineCreatorUserId,
    ],
  );
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION commitmentos.reject_deadline_audit_test()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.actor_type = 'SYSTEM' THEN
           RAISE EXCEPTION 'synthetic deadline audit insertion failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER reject_deadline_audit_test
       BEFORE INSERT ON commitmentos.commitment_audit_event
       FOR EACH ROW EXECUTE FUNCTION commitmentos.reject_deadline_audit_test()`,
    );
    await assert.rejects(
      evaluateWorkspaceCommitmentDeadlines(pool, isolationWorkspaceId, new Date()),
      /synthetic deadline audit insertion failure/,
      'A deadline status mutation must fail if its immutable audit record cannot be written.',
    );
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS reject_deadline_audit_test ON commitmentos.commitment_audit_event',
    );
    await pool.query('DROP FUNCTION IF EXISTS commitmentos.reject_deadline_audit_test()');
  }
  const rolledBackDeadline = await pool.query<{ status: string }>(
    'SELECT status FROM commitmentos.commitment WHERE id = $1',
    [atomicDeadlineId],
  );
  assert.equal(rolledBackDeadline.rows[0]?.status, 'OPEN');
  const rolledBackAudit = await pool.query<{ count: string }>(
    'SELECT count(*) FROM commitmentos.commitment_audit_event WHERE commitment_id = $1',
    [atomicDeadlineId],
  );
  assert.equal(rolledBackAudit.rows[0]?.count, '0');
  await pool.query('UPDATE commitmentos.commitment SET due_at = $2 WHERE id = $1', [
    atomicDeadlineId,
    futureDeadline,
  ]);

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
  assert.equal(
    workerLogs.join('\n').includes('Synthetic deadline integration commitment'),
    false,
    'Deadline worker logs must not contain commitment text.',
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
    'PostgreSQL and Redis/BullMQ job integration checks passed: idempotency, duplicate delivery, retry/timeout/dead-letter recovery, automated deadline sweeps with tenant scope and atomic SYSTEM audits, worker restart, redacted logs, and readiness.',
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
  const cleanupClient = await pool.connect().catch(() => undefined);
  if (cleanupClient) {
    try {
      await cleanupClient.query('BEGIN');
      await cleanupClient.query(
        'DELETE FROM commitmentos.async_job WHERE workspace_id = ANY($1::text[])',
        [workspaceIds],
      );
      await cleanupClient.query(
        'DELETE FROM commitmentos.background_worker_heartbeat WHERE worker_id = ANY($1::text[])',
        [[...workerIds]],
      );
      await cleanupClient.query(
        'ALTER TABLE commitmentos.commitment_audit_event DISABLE TRIGGER USER',
      );
      await cleanupClient.query(
        'DELETE FROM commitmentos.commitment_audit_event WHERE workspace_id = ANY($1::text[])',
        [workspaceIds],
      );
      await cleanupClient.query(
        'ALTER TABLE commitmentos.commitment_audit_event ENABLE TRIGGER USER',
      );
      await cleanupClient.query(
        'DELETE FROM commitmentos.commitment WHERE workspace_id = ANY($1::text[])',
        [workspaceIds],
      );
      await cleanupClient.query('DELETE FROM commitmentos.user WHERE id = $1', [
        deadlineCreatorUserId,
      ]);
      await cleanupClient.query('DELETE FROM commitmentos.workspace WHERE id = ANY($1::text[])', [
        workspaceIds,
      ]);
      await cleanupClient.query('COMMIT');
    } catch {
      await cleanupClient.query('ROLLBACK').catch(() => undefined);
    } finally {
      cleanupClient.release();
    }
  }
  await pool.end();
}
