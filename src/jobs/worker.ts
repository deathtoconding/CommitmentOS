import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getDatabaseUrl } from '@/db/config';
import { classifyJobFailure } from './model';
import { startJobWorker } from './worker-core';

const pool = new Pool({
  connectionString: getDatabaseUrl(),
  application_name: 'commitmentos-jobs-worker',
  max: 10,
});
const workerId = randomUUID();
let started: Awaited<ReturnType<typeof startJobWorker>> | undefined;

try {
  started = await startJobWorker({ pool, workerId });
} catch (error) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'commitmentos-jobs-worker',
      event: 'worker_start_failed',
      workerId,
      errorCode: classifyJobFailure(error).errorCode,
    }),
  );
}

if (!started) {
  await pool.end();
  process.exit(1);
}
const worker = started;

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'commitmentos-jobs-worker',
      event: 'worker_shutdown_requested',
      workerId,
      signal,
    }),
  );
  try {
    await worker.close();
  } finally {
    await pool.end();
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'commitmentos-jobs-worker',
      event: 'unhandled_rejection',
      errorCode: classifyJobFailure(error).errorCode,
    }),
  );
  process.exitCode = 1;
});
