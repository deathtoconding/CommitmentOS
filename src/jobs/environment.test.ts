import { describe, expect, it } from 'vitest';
import { getJobsEnvironment } from './environment';

const minimumEnvironment = {
  REDIS_URL: 'redis://localhost:6379',
};

describe('getJobsEnvironment', () => {
  it('applies production-safe defaults and accepts TLS Redis URLs', () => {
    expect(getJobsEnvironment(minimumEnvironment)).toMatchObject({
      redisUrl: 'redis://localhost:6379',
      queueName: 'commitmentos',
      queuePrefix: 'commitmentos',
      workerConcurrency: 5,
      maxAttempts: 5,
      backoffMs: 1_000,
      timeoutMs: 60_000,
      heartbeatIntervalMs: 10_000,
      heartbeatStaleMs: 30_000,
      recoveryIntervalMs: 5_000,
    });
    expect(getJobsEnvironment({ REDIS_URL: 'rediss://cache.example.test:6380' }).redisUrl).toBe(
      'rediss://cache.example.test:6380',
    );
  });

  it.each([
    { REDIS_URL: 'http://localhost:6379' },
    { REDIS_URL: 'redis://localhost:6379', JOB_WORKER_CONCURRENCY: '0' },
    { REDIS_URL: 'redis://localhost:6379', JOB_MAX_ATTEMPTS: '11' },
    { REDIS_URL: 'redis://localhost:6379', JOBS_QUEUE_NAME: 'invalid:queue' },
    {
      REDIS_URL: 'redis://localhost:6379',
      JOB_HEARTBEAT_INTERVAL_MS: '20000',
      JOB_HEARTBEAT_STALE_MS: '30000',
    },
  ])('rejects unsafe background job environment settings', (environment) => {
    expect(() => getJobsEnvironment(environment)).toThrow();
  });
});
