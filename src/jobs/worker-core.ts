import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { computeRetryDelay, classifyJobFailure, PermanentJobError, type JobKind } from './model';
import { createJobQueueClient, dispatchRecoverableJobs, type StoredJob } from './queue';
import { getJobsEnvironment, type JobsEnvironment } from './environment';

export type JobProcessorContext = {
  jobId: string;
  workspaceId: string;
  correlationId: string;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  pool: Pool;
};

export type JobProcessor = (context: JobProcessorContext) => Promise<void>;
export type JobProcessorMap = Partial<Record<JobKind, JobProcessor>>;

type QueueJobData = { jobId: string; correlationId: string };

const platformProbe: JobProcessor = async ({ workspaceId, signal, pool }) => {
  if (signal.aborted) throw signal.reason;
  const result = await pool.query('SELECT 1 FROM commitmentos.workspace WHERE id = $1 LIMIT 1', [
    workspaceId,
  ]);
  if (signal.aborted) throw signal.reason;
  if (result.rowCount !== 1) {
    throw new PermanentJobError('The workspace no longer exists.', 'WORKSPACE_NOT_FOUND');
  }
};

function logWorkerEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
) {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'commitmentos-jobs-worker',
      event,
      ...fields,
    }),
  );
}

function jobData(value: unknown): QueueJobData {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('jobId' in value) ||
    !('correlationId' in value) ||
    typeof value.jobId !== 'string' ||
    typeof value.correlationId !== 'string'
  ) {
    throw new PermanentJobError('The queue message is malformed.', 'INVALID_QUEUE_MESSAGE');
  }
  return { jobId: value.jobId, correlationId: value.correlationId };
}

async function executeJob(
  queueJob: Job<QueueJobData>,
  pool: Pool,
  environment: JobsEnvironment,
  processors: JobProcessorMap,
  deadLetterQueue: ReturnType<typeof createJobQueueClient>['deadLetterQueue'],
): Promise<{ jobId: string; status: string }> {
  let identifiers: QueueJobData;
  try {
    identifiers = jobData(queueJob.data);
  } catch (error) {
    throw new UnrecoverableError(classifyJobFailure(error).errorCode);
  }
  const { jobId, correlationId } = identifiers;
  const claimed = await pool.query<StoredJob>(
    `UPDATE commitmentos.async_job
     SET status = 'RUNNING',
         attempt_count = attempt_count + 1,
         started_at = now(),
         lease_expires_at = now() + (timeout_ms + 30000) * interval '1 millisecond',
         updated_at = now()
     WHERE id = $1
       AND correlation_id = $2
       AND status IN ('PENDING', 'QUEUED', 'RETRYING')
       AND available_at <= now()
     RETURNING id, workspace_id, kind, status, idempotency_key, correlation_id,
       payload, attempt_count, max_attempts, timeout_ms, available_at`,
    [jobId, correlationId],
  );
  const row = claimed.rows[0];
  if (!row) {
    const existing = await pool.query<{ status: string }>(
      'SELECT status FROM commitmentos.async_job WHERE id = $1 AND correlation_id = $2',
      [jobId, correlationId],
    );
    return { jobId, status: existing.rows[0]?.status ?? 'MISSING' };
  }

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    const processor = processors[row.kind];
    if (!processor) {
      throw new PermanentJobError(
        'No processor is registered for this job kind.',
        'JOB_HANDLER_UNAVAILABLE',
      );
    }

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = Object.assign(new Error('Background job deadline exceeded.'), {
          name: 'TimeoutError',
        });
        controller.abort(error);
        reject(error);
      }, row.timeout_ms);
      timeout.unref();
    });
    await Promise.race([
      Promise.resolve().then(() =>
        processor({
          jobId: row.id,
          workspaceId: row.workspace_id,
          correlationId,
          payload: row.payload,
          signal: controller.signal,
          pool,
        }),
      ),
      timeoutPromise,
    ]);
    await pool.query(
      `UPDATE commitmentos.async_job
       SET status = 'SUCCEEDED', completed_at = now(), lease_expires_at = NULL,
           failure_class = NULL, error_code = NULL, updated_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [row.id],
    );
    logWorkerEvent('job_succeeded', { jobId: row.id, correlationId, kind: row.kind });
    return { jobId: row.id, status: 'SUCCEEDED' };
  } catch (error) {
    const failure = classifyJobFailure(error);
    const retryable = failure.retryable && row.attempt_count < row.max_attempts;
    const retryDelayMs = Math.max(
      0,
      Math.min(
        24 * 60 * 60 * 1_000,
        failure.retryAfterMs ?? computeRetryDelay(row.attempt_count, environment.backoffMs),
      ),
    );
    await pool.query(
      `UPDATE commitmentos.async_job
       SET status = $2::commitmentos.async_job_status,
           available_at = CASE WHEN $2 = 'RETRYING' THEN now() + ($3 * interval '1 millisecond') ELSE available_at END,
           lease_expires_at = NULL,
           completed_at = CASE WHEN $2 = 'DEAD_LETTER' THEN now() ELSE NULL END,
           failure_class = $4::commitmentos.async_job_failure_class,
           error_code = $5,
           updated_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [
        row.id,
        retryable ? 'RETRYING' : 'DEAD_LETTER',
        retryDelayMs,
        failure.failureClass,
        failure.errorCode,
      ],
    );

    logWorkerEvent(retryable ? 'job_retry_scheduled' : 'job_dead_lettered', {
      jobId: row.id,
      correlationId,
      kind: row.kind,
      attempt: row.attempt_count,
      failureClass: failure.failureClass,
      errorCode: failure.errorCode,
      retryAfterMs: retryable ? retryDelayMs : undefined,
    });

    if (!retryable) {
      await deadLetterQueue
        .add(
          'failed',
          {
            jobId: row.id,
            correlationId,
            failureClass: failure.failureClass,
            errorCode: failure.errorCode,
            failedAt: new Date().toISOString(),
          },
          { jobId: `failed-${row.id}`, removeOnComplete: false, removeOnFail: false },
        )
        .catch(() => undefined);
      throw new UnrecoverableError(failure.errorCode);
    }

    throw Object.assign(
      new Error(failure.errorCode, {
        cause: { failureClass: failure.failureClass, errorCode: failure.errorCode },
      }),
      { code: failure.errorCode },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function recordHeartbeat(
  pool: Pool,
  workerId: string,
  queueName: string,
  status: 'READY' | 'DRAINING' | 'STOPPED',
) {
  await pool.query(
    `INSERT INTO commitmentos.background_worker_heartbeat (
       worker_id, queue_name, status, started_at, last_heartbeat_at, stopped_at, last_error_code
     ) VALUES (
       $1, $2, $3, now(), now(),
       CASE WHEN $3::commitmentos.background_worker_status = 'STOPPED' THEN now() ELSE NULL END,
       NULL
     )
     ON CONFLICT (worker_id) DO UPDATE SET
       queue_name = EXCLUDED.queue_name,
       status = EXCLUDED.status,
       last_heartbeat_at = now(),
       stopped_at = CASE
         WHEN EXCLUDED.status = 'STOPPED'::commitmentos.background_worker_status THEN now()
         ELSE NULL
       END,
       last_error_code = NULL`,
    [workerId, queueName, status],
  );
}

export async function startJobWorker(options: {
  pool: Pool;
  workerId: string;
  environment?: JobsEnvironment;
  processors?: JobProcessorMap;
}) {
  const environment = options.environment ?? getJobsEnvironment();
  const processors: JobProcessorMap = { PLATFORM_PROBE: platformProbe, ...options.processors };
  const queueClient = createJobQueueClient(environment);
  const worker = new Worker<QueueJobData, { jobId: string; status: string }>(
    environment.queueName,
    (job) => executeJob(job, options.pool, environment, processors, queueClient.deadLetterQueue),
    {
      connection: queueClient.connection,
      prefix: environment.queuePrefix,
      concurrency: environment.workerConcurrency,
      lockDuration: environment.timeoutMs + 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );

  worker.on('completed', (job, result) => {
    logWorkerEvent('queue_job_completed', {
      jobId: result.jobId,
      correlationId: job.data.correlationId,
    });
  });
  worker.on('failed', (job, error) => {
    if (!job) return;
    logWorkerEvent('queue_job_failed', {
      jobId: job.data.jobId,
      correlationId: job.data.correlationId,
      errorCode: classifyJobFailure(error).errorCode,
    });
  });
  worker.on('error', (error) => {
    logWorkerEvent('worker_error', {
      errorCode: classifyJobFailure(error).errorCode,
    });
  });

  let startupTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([
        worker.waitUntilReady(),
        queueClient.queue.waitUntilReady(),
        queueClient.deadLetterQueue.waitUntilReady(),
      ]).then(async () => {
        await queueClient.connection.ping();
        await options.pool.query('SELECT 1');
        await recordHeartbeat(options.pool, options.workerId, environment.queueName, 'READY');
      }),
      new Promise<never>((_resolve, reject) => {
        startupTimeout = setTimeout(
          () => reject(new Error('Worker dependency readiness timed out.')),
          15_000,
        );
        startupTimeout.unref();
      }),
    ]);
  } catch (error) {
    await worker.close(true).catch(() => undefined);
    await Promise.all([
      queueClient.queue.close().catch(() => undefined),
      queueClient.deadLetterQueue.close().catch(() => undefined),
    ]);
    queueClient.connection.disconnect();
    throw new Error('Background job worker could not establish required dependencies.', {
      cause: error,
    });
  } finally {
    if (startupTimeout) clearTimeout(startupTimeout);
  }

  let recoveryInProgress = false;
  const recover = async () => {
    if (recoveryInProgress) return;
    recoveryInProgress = true;
    try {
      const dispatched = await dispatchRecoverableJobs(
        options.pool,
        queueClient.queue,
        environment,
        100,
        queueClient.deadLetterQueue,
      );
      if (dispatched > 0) logWorkerEvent('recoverable_jobs_dispatched', { count: dispatched });
    } catch (error) {
      logWorkerEvent('job_recovery_failed', {
        errorCode: classifyJobFailure(error).errorCode,
      });
    } finally {
      recoveryInProgress = false;
    }
  };
  await recover();
  const recoveryTimer = setInterval(() => void recover(), environment.recoveryIntervalMs);
  recoveryTimer.unref();
  const heartbeatTimer = setInterval(() => {
    void recordHeartbeat(options.pool, options.workerId, environment.queueName, 'READY').catch(
      (error: unknown) => {
        logWorkerEvent('worker_heartbeat_failed', {
          errorCode: classifyJobFailure(error).errorCode,
        });
      },
    );
  }, environment.heartbeatIntervalMs);
  heartbeatTimer.unref();

  logWorkerEvent('worker_ready', {
    workerId: options.workerId,
    queueName: environment.queueName,
    concurrency: environment.workerConcurrency,
  });

  return {
    worker,
    queue: queueClient.queue,
    deadLetterQueue: queueClient.deadLetterQueue,
    connection: queueClient.connection,
    async close() {
      clearInterval(recoveryTimer);
      clearInterval(heartbeatTimer);
      await recordHeartbeat(
        options.pool,
        options.workerId,
        environment.queueName,
        'DRAINING',
      ).catch(() => undefined);
      let workerCloseError: unknown;
      try {
        await worker.close();
      } catch (error) {
        workerCloseError = error;
      }
      await Promise.all([
        queueClient.queue.close().catch(() => undefined),
        queueClient.deadLetterQueue.close().catch(() => undefined),
      ]);
      await recordHeartbeat(options.pool, options.workerId, environment.queueName, 'STOPPED').catch(
        () => undefined,
      );
      await queueClient.connection.quit().catch(() => queueClient.connection.disconnect());
      if (workerCloseError) {
        logWorkerEvent('worker_shutdown_incomplete', {
          workerId: options.workerId,
          errorCode: classifyJobFailure(workerCloseError).errorCode,
        });
      }
    },
  };
}
