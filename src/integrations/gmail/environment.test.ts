import { describe, expect, it } from 'vitest';
import {
  getGmailOAuthConfigurationState,
  getGmailOAuthEnvironment,
  getIntegrationEncryptionKey,
} from './environment';

const key = Buffer.alloc(32, 23).toString('base64');
const authEnvironment = {
  BETTER_AUTH_SECRET: 'commitmentos-integration-test-secret-value',
  BETTER_AUTH_URL: 'https://commitmentos.example.test',
  NODE_ENV: 'production',
};

const configured = {
  ...authEnvironment,
  GMAIL_OAUTH_ENABLED: 'true',
  GMAIL_CLIENT_ID: '123456789.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'google-oauth-client-secret-for-tests',
  INTEGRATION_ENCRYPTION_KEY: key,
};

describe('Gmail OAuth environment', () => {
  it('keeps Gmail disabled until explicitly enabled after policy approval', () => {
    expect(getGmailOAuthEnvironment({})).toBeNull();
    expect(getGmailOAuthConfigurationState({})).toBe('unconfigured');
    expect(getGmailOAuthEnvironment({ ...configured, GMAIL_OAUTH_ENABLED: 'false' })).toBeNull();
    expect(getGmailOAuthEnvironment({ ...configured, GMAIL_OAUTH_ENABLED: undefined })).toBeNull();
    expect(getGmailOAuthConfigurationState(configured)).toBe('ready');
    expect(() => getGmailOAuthEnvironment({ ...configured, GMAIL_OAUTH_ENABLED: 'yes' })).toThrow(
      'GMAIL_OAUTH_ENABLED',
    );
  });

  it('rejects partial credentials or a missing encryption key without returning secrets', () => {
    expect(() =>
      getGmailOAuthEnvironment({
        GMAIL_OAUTH_ENABLED: 'true',
        GMAIL_CLIENT_ID: configured.GMAIL_CLIENT_ID,
      }),
    ).toThrow('incomplete or invalid');
    expect(() =>
      getGmailOAuthEnvironment({ ...configured, INTEGRATION_ENCRYPTION_KEY: '' }),
    ).toThrow('INTEGRATION_ENCRYPTION_KEY');
    expect(
      getGmailOAuthConfigurationState({ ...configured, INTEGRATION_ENCRYPTION_KEY: 'bad' }),
    ).toBe('invalid');
  });

  it('validates a canonical base64 32-byte key and derives a fixed callback URL', () => {
    expect(getIntegrationEncryptionKey({ INTEGRATION_ENCRYPTION_KEY: key })).toEqual(
      Buffer.alloc(32, 23),
    );
    expect(() => getIntegrationEncryptionKey({ INTEGRATION_ENCRYPTION_KEY: `${key}\n` })).toThrow();
    expect(() =>
      getIntegrationEncryptionKey({ INTEGRATION_ENCRYPTION_KEY: 'not-base64' }),
    ).toThrow();
    expect(getGmailOAuthEnvironment(configured)).toMatchObject({
      clientId: configured.GMAIL_CLIENT_ID,
      callbackUrl: 'https://commitmentos.example.test/api/integrations/gmail/callback',
      encryptionKey: Buffer.alloc(32, 23),
    });
  });

  it('requires HTTPS for an externally hosted production callback', () => {
    expect(() =>
      getGmailOAuthEnvironment({
        ...configured,
        BETTER_AUTH_URL: 'http://commitmentos.example.test',
      }),
    ).toThrow('HTTPS');
  });
});
