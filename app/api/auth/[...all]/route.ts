import { toNextJsHandler } from 'better-auth/next-js';
import {
  claimEmailVerificationToken,
  EMAIL_VERIFICATION_CLAIM_HEADER,
  finalizeEmailVerificationToken,
  releaseEmailVerificationTokenClaim,
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

function invalidVerificationToken(): Response {
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

async function releaseFailedVerification(token: string, reservationId: string): Promise<void> {
  try {
    await releaseEmailVerificationTokenClaim(databasePool, token, reservationId);
  } catch {
    // The short reservation lease permits safe recovery if PostgreSQL is temporarily unavailable.
  }
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
  const token = url.pathname === '/api/auth/verify-email' ? url.searchParams.get('token') : null;
  const reservationId = token ? await claimEmailVerificationToken(databasePool, token) : null;

  if (token && !reservationId) return invalidVerificationToken();
  if (!token || !reservationId) return authHandlers.GET(request);

  const headers = new Headers(request.headers);
  // Replace any client-supplied value with the server-created claim identifier.
  headers.set(EMAIL_VERIFICATION_CLAIM_HEADER, reservationId);
  const claimedRequest = new Request(request.url, {
    method: 'GET',
    headers,
    signal: request.signal,
  });

  let response: Response;
  try {
    response = await authHandlers.GET(claimedRequest);
  } catch (error) {
    await releaseFailedVerification(token, reservationId);
    throw error;
  }

  const location = response.headers.get('location');
  let callback: URL | null = null;
  if (location) {
    try {
      callback = new URL(location, url.origin);
    } catch {
      // An invalid redirect is not accepted as successful token redemption.
    }
  }
  const failed =
    response.status >= 400 ||
    (response.status >= 300 &&
      response.status < 400 &&
      (!callback || callback.searchParams.has('error')));

  if (failed) {
    await releaseFailedVerification(token, reservationId);
    return response;
  }

  const finalized = await finalizeEmailVerificationToken(databasePool, token, reservationId);
  if (!finalized) return invalidVerificationToken();
  return response;
}

export const GET = handleGet;
export const POST = handlePost;
