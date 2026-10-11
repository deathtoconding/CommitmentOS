export function payloadTooLargeResponse(): Response {
  return Response.json(
    { error: 'PAYLOAD_TOO_LARGE' },
    { status: 413, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
