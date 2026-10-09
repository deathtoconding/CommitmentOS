import { databasePool } from '@/db/client';
import { getJobsEnvironment } from '@/jobs/environment';
import { getJobsMetricsToken, isJobsMetricsAuthorized, readJobsMetrics } from '@/jobs/metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const privateHeaders = {
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

export async function GET(request: Request): Promise<Response> {
  let token: string | null;
  try {
    token = getJobsMetricsToken();
  } catch {
    return new Response('Metrics are not configured.\n', {
      status: 503,
      headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (token === null) {
    return new Response(null, { status: 404, headers: privateHeaders });
  }
  if (!isJobsMetricsAuthorized(request.headers.get('authorization'), token)) {
    return new Response('Unauthorized.\n', {
      status: 401,
      headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  try {
    const environment = getJobsEnvironment();
    const metrics = await readJobsMetrics(
      databasePool,
      environment.queueName,
      environment.heartbeatStaleMs,
    );
    return new Response(metrics, {
      status: 200,
      headers: {
        ...privateHeaders,
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      },
    });
  } catch {
    return new Response('Metrics are temporarily unavailable.\n', {
      status: 503,
      headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
