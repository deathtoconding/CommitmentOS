import { describe, expect, it } from 'vitest';
import { getAuthEnvironment } from './environment';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'local-test-secret-with-more-than-thirty-two-characters',
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('getAuthEnvironment', () => {
  it('requires a long secret and a valid application URL', () => {
    expect(() => getAuthEnvironment({ ...validEnvironment, BETTER_AUTH_SECRET: 'short' })).toThrow(
      'BETTER_AUTH_SECRET',
    );
    expect(() => getAuthEnvironment({ ...validEnvironment, BETTER_AUTH_URL: 'not-a-url' })).toThrow(
      'BETTER_AUTH_SECRET',
    );
  });

  it('requires HTTPS for non-loopback production URLs', () => {
    expect(() =>
      getAuthEnvironment(
        { ...validEnvironment, BETTER_AUTH_URL: 'http://commitmentos.example.com' },
        'production',
      ),
    ).toThrow('HTTPS in production');

    expect(
      getAuthEnvironment(
        { ...validEnvironment, BETTER_AUTH_URL: 'https://commitmentos.example.com' },
        'production',
      ).baseURL,
    ).toBe('https://commitmentos.example.com');
  });

  it('allows the preview origin only in development', () => {
    expect(getAuthEnvironment(validEnvironment, 'development').trustedOrigins).toContain(
      'https://*.e2b.app',
    );
    expect(getAuthEnvironment(validEnvironment, 'production').trustedOrigins).not.toContain(
      'https://*.e2b.app',
    );
  });
});
