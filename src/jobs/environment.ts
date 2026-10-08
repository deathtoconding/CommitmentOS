import { z } from 'zod';

const jobsEnvironmentSchema = z.object({
  REDIS_URL: z.url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol)),
  JOBS_QUEUE_NAME: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('commitmentos'),
  JOBS_QUEUE_PREFIX: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_:-]+$/)
    .default('commitmentos'),
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(5),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  JOB_BACKOFF_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
  JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(15 * 60_000)
    .default(60_000),
  JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  JOB_HEARTBEAT_STALE_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(5 * 60_000)
    .default(30_000),
  JOB_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
});

export type JobsEnvironment = {
  redisUrl: string;
  queueName: string;
  queuePrefix: string;
  workerConcurrency: number;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  recoveryIntervalMs: number;
};

export function getJobsEnvironment(
  environment: Record<string, string | undefined> = process.env,
): JobsEnvironment {
  const result = jobsEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error('Background jobs require a valid REDIS_URL and valid JOB_* settings.');
  }

  if (result.data.JOB_HEARTBEAT_STALE_MS < result.data.JOB_HEARTBEAT_INTERVAL_MS * 2) {
    throw new Error('JOB_HEARTBEAT_STALE_MS must be at least twice the worker heartbeat interval.');
  }

  return {
    redisUrl: result.data.REDIS_URL,
    queueName: result.data.JOBS_QUEUE_NAME,
    queuePrefix: result.data.JOBS_QUEUE_PREFIX,
    workerConcurrency: result.data.JOB_WORKER_CONCURRENCY,
    maxAttempts: result.data.JOB_MAX_ATTEMPTS,
    backoffMs: result.data.JOB_BACKOFF_MS,
    timeoutMs: result.data.JOB_TIMEOUT_MS,
    heartbeatIntervalMs: result.data.JOB_HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs: result.data.JOB_HEARTBEAT_STALE_MS,
    recoveryIntervalMs: result.data.JOB_RECOVERY_INTERVAL_MS,
  };
}
