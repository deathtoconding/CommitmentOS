import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { JOB_STATUSES, type JobStatus } from './model';

export type JobsMetricsSnapshot = {
  jobCounts: Record<JobStatus, number>;
  readyWorkers: number;
  oldestIncompleteAgeSeconds: number;
};

const workerTokenPattern = /^[A-Za-z0-9._~-]+$/;

export function getJobsMetricsToken(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const token = environment.JOBS_METRICS_TOKEN;
  if (token === undefined || token === '') return null;
  if (
    token.length < 32 ||
    token.length > 512 ||
    token.trim() !== token ||
    !workerTokenPattern.test(token)
  ) {
    throw new Error('JOBS_METRICS_TOKEN must be a 32–512 character URL-safe secret.');
  }
  return token;
}

export function isJobsMetricsAuthorized(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;

  const suppliedToken = authorizationHeader.slice('Bearer '.length);
  if (!workerTokenPattern.test(suppliedToken)) return false;
  const supplied = Buffer.from(suppliedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function formatJobsMetrics(snapshot: JobsMetricsSnapshot): string {
  const lines = [
    '# HELP commitmentos_jobs_total Durable jobs grouped by persisted status.',
    '# TYPE commitmentos_jobs_total gauge',
  ];

  for (const status of JOB_STATUSES) {
    const count = snapshot.jobCounts[status];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Job metric counts must be nonnegative integers.');
    }
    lines.push(`commitmentos_jobs_total{status="${status}"} ${count}`);
  }

  if (
    !Number.isSafeInteger(snapshot.readyWorkers) ||
    snapshot.readyWorkers < 0 ||
    !Number.isSafeInteger(snapshot.oldestIncompleteAgeSeconds) ||
    snapshot.oldestIncompleteAgeSeconds < 0
  ) {
    throw new TypeError('Worker metrics must be nonnegative integers.');
  }

  lines.push(
    '# HELP commitmentos_ready_workers Current workers with a fresh ready heartbeat.',
    '# TYPE commitmentos_ready_workers gauge',
    `commitmentos_ready_workers ${snapshot.readyWorkers}`,
    '# HELP commitmentos_jobs_oldest_incomplete_age_seconds Age of the oldest incomplete durable job.',
    '# TYPE commitmentos_jobs_oldest_incomplete_age_seconds gauge',
    `commitmentos_jobs_oldest_incomplete_age_seconds ${snapshot.oldestIncompleteAgeSeconds}`,
  );
  return `${lines.join('\n')}\n`;
}

export async function readJobsMetrics(
  pool: Pool,
  queueName: string,
  heartbeatStaleMs: number,
): Promise<string> {
  const [jobCounts, readyWorkers, oldestIncomplete] = await Promise.all([
    pool.query<{ status: JobStatus; count: number }>(
      `SELECT status::text AS status, count(*)::int AS count
       FROM commitmentos.async_job
       GROUP BY status`,
    ),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM commitmentos.background_worker_heartbeat
       WHERE queue_name = $1 AND status = 'READY'
         AND last_heartbeat_at >= now() - ($2 * interval '1 millisecond')`,
      [queueName, heartbeatStaleMs],
    ),
    pool.query<{ age_seconds: number }>(
      `SELECT GREATEST(COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at))::int, 0), 0) AS age_seconds
       FROM commitmentos.async_job
       WHERE status IN ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`,
    ),
  ]);

  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<
    JobStatus,
    number
  >;
  for (const row of jobCounts.rows) {
    if (JOB_STATUSES.includes(row.status)) counts[row.status] = row.count;
  }

  return formatJobsMetrics({
    jobCounts: counts,
    readyWorkers: readyWorkers.rows[0]?.count ?? 0,
    oldestIncompleteAgeSeconds: oldestIncomplete.rows[0]?.age_seconds ?? 0,
  });
}
