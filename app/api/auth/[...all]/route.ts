import { toNextJsHandler } from 'better-auth/next-js';
import { loginSchema, registrationSchema } from '@/auth/schemas';
import { auth } from '@/auth/server';
import { readBoundedRequestBody } from '@/http/request-body';
import { payloadTooLargeResponse } from '@/http/responses';

const authHandlers = toNextJsHandler(auth);

function invalidRequest(): Response {
  return Response.json(
    { code: 'INVALID_AUTH_REQUEST', message: 'Please check the submitted information.' },
    { status: 400 },
  );
}

async function handlePost(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const schema =
    pathname === '/api/auth/sign-up/email'
      ? registrationSchema
      : pathname === '/api/auth/sign-in/email'
        ? loginSchema
        : null;

  const boundedBody = await readBoundedRequestBody(request);
  if (!boundedBody.ok) {
    return boundedBody.reason === 'too-large' ? payloadTooLargeResponse() : invalidRequest();
  }

  const headers = new Headers(request.headers);
  headers.delete('content-length');

  if (!schema) {
    const boundedRequest = new Request(request.url, {
      method: 'POST',
      headers,
      body: boundedBody.bytes.length > 0 ? boundedBody.bytes : null,
      signal: request.signal,
    });
    return authHandlers.POST(boundedRequest);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(boundedBody.bytes)) as unknown;
  } catch {
    return invalidRequest();
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    return invalidRequest();
  }

  const validatedRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(result.data),
    signal: request.signal,
  });

  return authHandlers.POST(validatedRequest);
}

export const GET = authHandlers.GET;
export const POST = handlePost;
