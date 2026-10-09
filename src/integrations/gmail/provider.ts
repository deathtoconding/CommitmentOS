import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, KeyInput } from 'jose';
import { z } from 'zod';
import type { GmailOAuthEnvironment } from './environment';
import { GMAIL_PROVIDER_TIMEOUT_MS, GMAIL_REQUIRED_SCOPES } from './model';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_ID_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: GMAIL_PROVIDER_TIMEOUT_MS,
  cooldownDuration: 30_000,
  cacheMaxAge: 60 * 60 * 1000,
});
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8192),
    token_type: z.string().min(1).max(32),
    expires_in: z.number().int().positive().max(31_536_000),
    refresh_token: z.string().min(1).max(8192).optional(),
    id_token: z.string().min(1).max(8192),
    scope: z.string().min(1).max(8192),
  })
  .passthrough();

const identityClaimsSchema = z.object({
  sub: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => value === value.trim()),
  email: z.string().email().max(320),
  email_verified: z.literal(true),
  nonce: z.string().min(32).max(128),
});

export class GmailProviderError extends Error {
  readonly code:
    'GMAIL_PROVIDER_UNAVAILABLE' | 'GMAIL_PROVIDER_REJECTED' | 'GMAIL_PROVIDER_INVALID_RESPONSE';
  readonly retryable: boolean;

  constructor(code: GmailProviderError['code'], retryable: boolean) {
    super(code);
    this.name = 'GmailProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type GmailTokenResponse = z.infer<typeof tokenResponseSchema>;
export type GmailIdentity = { sub: string; email: string };

export function parseGmailGrantedScopes(scopeValue: string): string[] {
  const scopes = scopeValue.trim().split(/\s+/).filter(Boolean);
  const uniqueScopes = [...new Set(scopes)].sort();
  const expected = [...GMAIL_REQUIRED_SCOPES].sort();
  if (
    uniqueScopes.length !== expected.length ||
    uniqueScopes.some((scope, index) => scope !== expected[index])
  ) {
    throw new GmailProviderError('GMAIL_PROVIDER_REJECTED', false);
  }
  return uniqueScopes;
}

export function buildGmailAuthorizationUrl(
  configuration: GmailOAuthEnvironment,
  input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  },
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('redirect_uri', configuration.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_REQUIRED_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailProviderError(
      response.status === 429 || response.status >= 500
        ? 'GMAIL_PROVIDER_UNAVAILABLE'
        : 'GMAIL_PROVIDER_REJECTED',
      response.status === 429 || response.status >= 500,
    );
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GmailProviderError) throw error;
    throw new GmailProviderError('GMAIL_PROVIDER_UNAVAILABLE', true);
  }

  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    return JSON.parse(body) as unknown;
  } catch {
    throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
  }
}

export async function exchangeGmailAuthorizationCode(
  configuration: GmailOAuthEnvironment,
  code: string,
  codeVerifier: string,
): Promise<GmailTokenResponse> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        redirect_uri: configuration.callbackUrl,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(GMAIL_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new GmailProviderError('GMAIL_PROVIDER_UNAVAILABLE', true);
  }

  const result = tokenResponseSchema.safeParse(await readBoundedJson(response));
  if (!result.success || result.data.token_type.toLowerCase() !== 'bearer') {
    throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
  }
  parseGmailGrantedScopes(result.data.scope);
  return result.data;
}

export function parseGmailIdentityClaims(
  claims: unknown,
  expectedNonceHash: string,
): GmailIdentity {
  const result = identityClaimsSchema.safeParse(claims);
  if (!result.success || !/^[a-f0-9]{64}$/.test(expectedNonceHash)) {
    throw new GmailProviderError('GMAIL_PROVIDER_INVALID_RESPONSE', false);
  }

  const actualNonceHash = createHash('sha256').update(result.data.nonce, 'utf8').digest();
  const expectedNonce = Buffer.from(expectedNonceHash, 'hex');
  if (
    actualNonceHash.length !== expectedNonce.length ||
    !timingSafeEqual(actualNonceHash, expectedNonce)
  ) {
    throw new GmailProviderError('GMAIL_PROVIDER_REJECTED', false);
  }
  return { sub: result.data.sub, email: result.data.email };
}

export async function verifyGmailIdentityToken(
  idToken: string,
  clientId: string,
  expectedNonceHash: string,
  verificationKey: KeyInput | JWTVerifyGetKey = googleJwks,
): Promise<GmailIdentity> {
  try {
    const verified = await jwtVerify(idToken, verificationKey, {
      issuer: [...GOOGLE_ID_TOKEN_ISSUERS],
      audience: clientId,
      algorithms: ['RS256'],
      maxTokenAge: '10 minutes',
      clockTolerance: 5,
      requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'],
    });
    return parseGmailIdentityClaims(verified.payload, expectedNonceHash);
  } catch (error) {
    if (error instanceof GmailProviderError) throw error;
    const retryableErrors = new Set(['JWKSTimeout', 'FetchError', 'TimeoutError', 'TypeError']);
    throw new GmailProviderError(
      retryableErrors.has(error instanceof Error ? error.name : '')
        ? 'GMAIL_PROVIDER_UNAVAILABLE'
        : 'GMAIL_PROVIDER_REJECTED',
      retryableErrors.has(error instanceof Error ? error.name : ''),
    );
  }
}

/** Revocation uses a form body; failures are handled as pending revocations by the caller. */
export async function revokeGmailToken(token: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_REVOCATION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(GMAIL_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}
