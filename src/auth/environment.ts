import { z } from 'zod';

const authEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32).max(256),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional().default(''),
});

export type AuthEnvironment = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
};

export function getAuthEnvironment(
  environment: Record<string, string | undefined> = process.env,
  nodeEnvironment = environment.NODE_ENV,
): AuthEnvironment {
  const result = authEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(
      'Authentication requires BETTER_AUTH_SECRET (at least 32 characters) and a valid BETTER_AUTH_URL.',
    );
  }

  const baseURL = new URL(result.data.BETTER_AUTH_URL);
  if (!['http:', 'https:'].includes(baseURL.protocol)) {
    throw new Error('BETTER_AUTH_URL must use HTTP or HTTPS.');
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname);
  if (nodeEnvironment === 'production' && baseURL.protocol !== 'https:' && !isLoopback) {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
  }

  const configuredOrigins = result.data.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const developmentOrigins =
    nodeEnvironment === 'development' ? ['http://localhost:3000', 'https://*.e2b.app'] : [];

  return {
    secret: result.data.BETTER_AUTH_SECRET,
    baseURL: baseURL.origin,
    trustedOrigins: [...new Set([...configuredOrigins, ...developmentOrigins])],
  };
}
