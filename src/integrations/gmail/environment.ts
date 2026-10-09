import { z } from 'zod';
import { getAuthEnvironment } from '../../auth/environment';

const gmailClientEnvironmentSchema = z.object({
  GMAIL_CLIENT_ID: z.string().trim().min(1).max(512),
  GMAIL_CLIENT_SECRET: z.string().min(1).max(2048),
});

export type GmailOAuthEnvironment = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  encryptionKey: Buffer;
};

export function getIntegrationEncryptionKey(
  environment: Record<string, string | undefined> = process.env,
): Buffer {
  const encodedKey = environment.INTEGRATION_ENCRYPTION_KEY;
  if (!encodedKey || encodedKey.length > 128 || encodedKey.trim() !== encodedKey) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

/** The provider stays disabled until an operator explicitly enables the approved scope set. */
export function getGmailOAuthEnvironment(
  environment: Record<string, string | undefined> = process.env,
  nodeEnvironment = environment.NODE_ENV,
): GmailOAuthEnvironment | null {
  const enabled = environment.GMAIL_OAUTH_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new Error('GMAIL_OAUTH_ENABLED must be exactly true or false.');
  }
  if (enabled !== 'true') return null;

  const clientId = environment.GMAIL_CLIENT_ID;
  const clientSecret = environment.GMAIL_CLIENT_SECRET;
  const result = gmailClientEnvironmentSchema.safeParse({
    GMAIL_CLIENT_ID: clientId,
    GMAIL_CLIENT_SECRET: clientSecret,
  });
  if (!result.success) {
    throw new Error('Gmail OAuth client credentials are incomplete or invalid.');
  }

  const authEnvironment = getAuthEnvironment(environment, nodeEnvironment);
  const encryptionKey = getIntegrationEncryptionKey(environment);
  return {
    clientId: result.data.GMAIL_CLIENT_ID,
    clientSecret: result.data.GMAIL_CLIENT_SECRET,
    callbackUrl: new URL('/api/integrations/gmail/callback', authEnvironment.baseURL).toString(),
    encryptionKey,
  };
}

export function getGmailOAuthConfigurationState(
  environment: Record<string, string | undefined> = process.env,
): 'ready' | 'unconfigured' | 'invalid' {
  try {
    return getGmailOAuthEnvironment(environment) ? 'ready' : 'unconfigured';
  } catch {
    return 'invalid';
  }
}
