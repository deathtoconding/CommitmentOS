export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return Response.json(
    { status: 'live' },
    {
      headers: { 'cache-control': 'no-store, max-age=0' },
    },
  );
}
