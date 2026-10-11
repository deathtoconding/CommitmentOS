import { databasePool } from '@/db/client';
import { getJobsEnvironment } from '@/jobs/environment';
import { getJobReadiness } from '@/jobs/readiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const readiness = await getJobReadiness(databasePool, getJobsEnvironment());
    return Response.json(readiness, {
      status: readiness.ready ? 200 : 503,
      headers: { 'cache-control': 'no-store, max-age=0' },
    });
  } catch {
    return Response.json(
      {
        ready: false,
        dependencies: { postgres: 'not_ready', redis: 'not_ready', worker: 'not_ready' },
      },
      { status: 503, headers: { 'cache-control': 'no-store, max-age=0' } },
    );
  }
}
