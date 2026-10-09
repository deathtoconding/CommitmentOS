import 'server-only';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { database, databasePool } from '@/db/client';
import { account, rateLimit, session, user, verification } from '@/db/schema';
import {
  EMAIL_VERIFICATION_CLAIM_HEADER,
  EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
  finalizeEmailVerificationToken,
  isEmailVerificationTokenClaimed,
} from './email-verification-token';
import { sendPasswordResetEmail, sendVerificationEmail } from './email-delivery';
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
    schema: { user, session, account, verification, rateLimit },
    debugLogs: false,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: sendPasswordResetEmail,
  },
  verification: {
    storeIdentifier: 'hashed',
  },
  emailVerification: {
    sendVerificationEmail,
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
    autoSignInAfterVerification: false,
    async beforeEmailVerification(_user, request) {
      const token = request ? new URL(request.url).searchParams.get('token') : null;
      const reservationId = request?.headers.get(EMAIL_VERIFICATION_CLAIM_HEADER) ?? '';
      if (!token || !(await isEmailVerificationTokenClaimed(databasePool, token, reservationId))) {
        throw APIError.from('BAD_REQUEST', {
          code: 'INVALID_TOKEN',
          message: 'The email verification link is invalid, expired, or already used.',
        });
      }
    },
    async afterEmailVerification(_user, request) {
      const token = request ? new URL(request.url).searchParams.get('token') : null;
      const reservationId = request?.headers.get(EMAIL_VERIFICATION_CLAIM_HEADER) ?? '';
      if (!token || !(await finalizeEmailVerificationToken(databasePool, token, reservationId))) {
        throw APIError.from('BAD_REQUEST', {
          code: 'INVALID_TOKEN',
          message: 'The email verification link is invalid, expired, or already used.',
        });
      }
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },
  advanced: {
    cookiePrefix: 'commitmentos',
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
  rateLimit: {
    enabled: process.env.NODE_ENV === 'production',
    storage: 'database',
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
      '/send-verification-email': { window: 60, max: 3 },
      '/request-password-reset': { window: 60, max: 3 },
      '/reset-password': { window: 60, max: 5 },
    },
  },
  telemetry: {
    enabled: false,
  },
});
