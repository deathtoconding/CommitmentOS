import 'server-only';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { database } from '@/db/client';
import { account, session, user, verification } from '@/db/schema';
import { getAuthEnvironment } from './environment';

const authEnvironment = getAuthEnvironment();

export const auth = betterAuth({
  appName: 'CommitmentOS',
  baseURL: authEnvironment.baseURL,
  secret: authEnvironment.secret,
  trustedOrigins: authEnvironment.trustedOrigins,
  database: drizzleAdapter(database, {
    provider: 'pg',
    schemaName: 'commitmentos',
    schema: { user, session, account, verification },
    debugLogs: false,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    minPasswordLength: 12,
    maxPasswordLength: 128,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  advanced: {
    cookiePrefix: 'commitmentos',
  },
  rateLimit: {
    enabled: process.env.NODE_ENV === 'production',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
    },
  },
  telemetry: {
    enabled: false,
  },
});
