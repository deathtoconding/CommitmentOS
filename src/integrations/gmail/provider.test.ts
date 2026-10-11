import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { GmailOAuthEnvironment } from './environment';
import { GMAIL_REQUIRED_SCOPES } from './model';
import {
  buildGmailAuthorizationUrl,
  parseGmailGrantedScopes,
  parseGmailIdentityClaims,
  verifyGmailIdentityToken,
} from './provider';

const configuration: GmailOAuthEnvironment = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  callbackUrl: 'https://app.example.test/api/integrations/gmail/callback',
  encryptionKey: Buffer.alloc(32, 1),
};

describe('Gmail OAuth protocol configuration', () => {
  it('requests only the least-privilege identity and Gmail read-only scopes', () => {
    expect(parseGmailGrantedScopes([...GMAIL_REQUIRED_SCOPES].reverse().join(' '))).toEqual(
      [...GMAIL_REQUIRED_SCOPES].sort(),
    );
    expect(() =>
      parseGmailGrantedScopes(
        [...GMAIL_REQUIRED_SCOPES, 'https://www.googleapis.com/auth/gmail.modify'].join(' '),
      ),
    ).toThrow('GMAIL_PROVIDER_REJECTED');
    expect(() => parseGmailGrantedScopes(GMAIL_REQUIRED_SCOPES[0])).toThrow(
      'GMAIL_PROVIDER_REJECTED',
    );
  });

  it('requires a verified identity claim bound to the stored one-time OIDC nonce', () => {
    const nonce = 'one-time-oauth-nonce-value-0123456789';
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    const claims = {
      sub: 'stable-provider-account-subject',
      email: 'connected@example.test',
      email_verified: true,
      nonce,
    };

    expect(parseGmailIdentityClaims(claims, nonceHash)).toEqual({
      sub: claims.sub,
      email: claims.email,
    });
    expect(() =>
      parseGmailIdentityClaims({ ...claims, nonce: `${nonce}-wrong` }, nonceHash),
    ).toThrow('GMAIL_PROVIDER_REJECTED');
    expect(() => parseGmailIdentityClaims({ ...claims, email_verified: false }, nonceHash)).toThrow(
      'GMAIL_PROVIDER_INVALID_RESPONSE',
    );
  });

  it('verifies the signed OpenID token issuer, audience, age, algorithm, email, and nonce', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const nonce = 'one-time-oauth-nonce-value-0123456789';
    const nonceHash = createHash('sha256').update(nonce).digest('hex');

    const signToken = async (
      claims: Record<string, unknown> = {},
      options?: {
        issuer?: string;
        audience?: string;
        issuedAt?: number;
        expiresAt?: number;
      },
    ) => {
      const token = new SignJWT({
        sub: 'stable-provider-account-subject',
        email: 'connected@example.test',
        email_verified: true,
        nonce,
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(options?.issuer ?? 'https://accounts.google.com')
        .setAudience(options?.audience ?? configuration.clientId)
        .setIssuedAt(options?.issuedAt ?? Math.floor(Date.now() / 1000))
        .setExpirationTime(options?.expiresAt ?? Math.floor(Date.now() / 1000) + 300);
      return token.sign(privateKey);
    };

    const validToken = await signToken();
    await expect(
      verifyGmailIdentityToken(validToken, configuration.clientId, nonceHash, publicKey),
    ).resolves.toEqual({ sub: 'stable-provider-account-subject', email: 'connected@example.test' });

    const wrongAudience = await signToken({}, { audience: 'another-client-id' });
    await expect(
      verifyGmailIdentityToken(wrongAudience, configuration.clientId, nonceHash, publicKey),
    ).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_REJECTED' });

    const wrongIssuer = await signToken({}, { issuer: 'https://attacker.example.test' });
    await expect(
      verifyGmailIdentityToken(wrongIssuer, configuration.clientId, nonceHash, publicKey),
    ).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_REJECTED' });

    const wrongNonce = await signToken({ nonce: `${nonce}-replayed` });
    await expect(
      verifyGmailIdentityToken(wrongNonce, configuration.clientId, nonceHash, publicKey),
    ).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_REJECTED' });

    const unverifiedEmail = await signToken({ email_verified: false });
    await expect(
      verifyGmailIdentityToken(unverifiedEmail, configuration.clientId, nonceHash, publicKey),
    ).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_INVALID_RESPONSE' });

    const currentTime = Math.floor(Date.now() / 1000);
    const staleToken = await signToken(
      {},
      { issuedAt: currentTime - 700, expiresAt: currentTime + 300 },
    );
    await expect(
      verifyGmailIdentityToken(staleToken, configuration.clientId, nonceHash, publicKey),
    ).rejects.toMatchObject({ code: 'GMAIL_PROVIDER_REJECTED' });
  });

  it('uses a fixed Google authorization endpoint with state, PKCE, offline access, and no redirect input', () => {
    const authorization = new URL(
      buildGmailAuthorizationUrl(configuration, {
        state: 'opaque-state-value',
        nonce: 'opaque-nonce-value',
        codeChallenge: 'pkce-challenge-value',
      }),
    );

    expect(authorization.origin).toBe('https://accounts.google.com');
    expect(authorization.pathname).toBe('/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('client_id')).toBe(configuration.clientId);
    expect(authorization.searchParams.get('redirect_uri')).toBe(configuration.callbackUrl);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('scope')).toBe(GMAIL_REQUIRED_SCOPES.join(' '));
    expect(authorization.searchParams.get('state')).toBe('opaque-state-value');
    expect(authorization.searchParams.get('nonce')).toBe('opaque-nonce-value');
    expect(authorization.searchParams.get('code_challenge')).toBe('pkce-challenge-value');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('prompt')).toBe('consent');
    expect(authorization.searchParams.has('redirect')).toBe(false);
    expect(authorization.searchParams.has('include_granted_scopes')).toBe(false);
  });
});
