import { describe, expect, it } from 'vitest';
import { JOB_STATUSES } from './model';
import { formatJobsMetrics, getJobsMetricsToken, isJobsMetricsAuthorized } from './metrics';

const secret = 'commitmentos-ci-observability-token-2026';

describe('background job metrics', () => {
  it('disables the endpoint when no metrics secret is configured', () => {
    expect(getJobsMetricsToken({})).toBeNull();
    expect(getJobsMetricsToken({ JOBS_METRICS_TOKEN: '' })).toBeNull();
  });

  it('requires a sufficiently strong URL-safe secret without whitespace', () => {
    expect(getJobsMetricsToken({ JOBS_METRICS_TOKEN: secret })).toBe(secret);
    expect(() => getJobsMetricsToken({ JOBS_METRICS_TOKEN: 'short' })).toThrow();
    expect(() => getJobsMetricsToken({ JOBS_METRICS_TOKEN: `${secret} ` })).toThrow();
    expect(() => getJobsMetricsToken({ JOBS_METRICS_TOKEN: `${secret}\n` })).toThrow();
  });

  it('authorizes only an exact Bearer token', () => {
    expect(isJobsMetricsAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(isJobsMetricsAuthorized(`bearer ${secret}`, secret)).toBe(false);
    expect(isJobsMetricsAuthorized(secret, secret)).toBe(false);
    expect(isJobsMetricsAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isJobsMetricsAuthorized('Bearer', secret)).toBe(false);
    expect(isJobsMetricsAuthorized(null, secret)).toBe(false);
  });

  it('exports aggregate counts and a bounded worker signal without identifiers or payloads', () => {
    const jobCounts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<
      (typeof JOB_STATUSES)[number],
      number
    >;
    jobCounts.PENDING = 2;
    jobCounts.DEAD_LETTER = 1;
    const output = formatJobsMetrics({
      jobCounts,
      readyWorkers: 1,
      oldestIncompleteAgeSeconds: 45,
    });

    expect(output).toContain('commitmentos_jobs_total{status="PENDING"} 2');
    expect(output).toContain('commitmentos_jobs_total{status="DEAD_LETTER"} 1');
    expect(output).toContain('commitmentos_ready_workers 1');
    expect(output).toContain('commitmentos_jobs_oldest_incomplete_age_seconds 45');
    expect(output).not.toMatch(/workspace|correlation|payload|job_id|secret/i);
  });

  it('rejects invalid metric snapshots rather than emitting corrupt values', () => {
    const jobCounts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<
      (typeof JOB_STATUSES)[number],
      number
    >;
    jobCounts.RUNNING = -1;
    expect(() =>
      formatJobsMetrics({ jobCounts, readyWorkers: 0, oldestIncompleteAgeSeconds: 0 }),
    ).toThrow('Job metric counts must be nonnegative integers.');
  });
});
