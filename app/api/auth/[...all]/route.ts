import { toNextJsHandler } from 'better-auth/next-js';
import {
  consumeEmailVerificationToken,
  isEmailVerificationTokenConsumed,
} from '@/auth/email-verification-token';
import { loginSchema, registrationSchema } from '@/auth/schemas';
import { auth } from '@/auth/server';
import { databasePool } from '@/db/client';
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

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth/verify-email') {
    const token = url.searchParams.get('token');
    if (token && (await isEmailVerificationTokenConsumed(databasePool, token))) {
      return Response.json(
        {
          code: 'INVALID_TOKEN',
          message: 'The email verification link is invalid, expired, or already used.',
        },
        {
          status: 400,
          headers: {
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          },
        },
      );
    }
  }

  const response = await authHandlers.GET(request);
  const token = url.searchParams.get('token');
  if (url.pathname === '/api/auth/verify-email' && token && response.status === 302) {
    const location = response.headers.get('location');
    const callback = location ? new URL(location, url.origin) : null;
    const errorCode = callback?.searchParams.get('error');
    const verificationErrorCodes = new Set([
      'INVALID_TOKEN',
      'TOKEN_EXPIRED',
      'USER_NOT_FOUND',
      'INVALID_USER',
    ]);

    if (!errorCode || !verificationErrorCodes.has(errorCode)) {
      // Also consume successful links for accounts verified by another still-valid link.
      await consumeEmailVerificationToken(databasePool, token);
    }
  }

  return response;
}

export const GET = handleGet;
export const POST = handlePost;
