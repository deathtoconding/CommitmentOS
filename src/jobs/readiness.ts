import type { Pool } from 'pg';
import { getJobsEnvironment, type JobsEnvironment } from './environment';
import { createRedisConnection } from './queue';

export type JobReadiness = {
  ready: boolean;
  dependencies: {
    postgres: 'ready' | 'not_ready';
    redis: 'ready' | 'not_ready';
    worker: 'ready' | 'not_ready';
  };
};

export async function getJobReadiness(
  pool: Pool,
  environment: JobsEnvironment = getJobsEnvironment(),
): Promise<JobReadiness> {
  const dependencies: JobReadiness['dependencies'] = {
    postgres: 'not_ready',
    redis: 'not_ready',
    worker: 'not_ready',
  };

  try {
    await pool.query('SELECT 1');
    dependencies.postgres = 'ready';
  } catch {
    // Keep diagnostics intentionally coarse; database error messages may contain connection details.
  }

  const redis = createRedisConnection(environment);
  try {
    const ping = redis.ping();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ping,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Redis readiness check timed out.')), 2_000);
          timeout.unref();
        }),
      ]);
      dependencies.redis = 'ready';
    } catch {
      dependencies.redis = 'not_ready';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    if (dependencies.redis === 'ready') {
      await redis.quit().catch(() => redis.disconnect());
    } else {
      redis.disconnect();
    }
  }

  if (dependencies.postgres === 'ready') {
    try {
      const heartbeat = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM commitmentos.background_worker_heartbeat
           WHERE queue_name = $1 AND status = 'READY'
             AND last_heartbeat_at >= now() - ($2 * interval '1 millisecond')
         ) AS present`,
        [environment.queueName, environment.heartbeatStaleMs],
      );
      dependencies.worker = heartbeat.rows[0]?.present === true ? 'ready' : 'not_ready';
    } catch {
      dependencies.worker = 'not_ready';
    }
  }

  return {
    ready: Object.values(dependencies).every((status) => status === 'ready'),
    dependencies,
  };
}
