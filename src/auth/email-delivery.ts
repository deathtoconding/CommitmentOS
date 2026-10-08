import 'server-only';
import { readFileSync } from 'node:fs';
import { after } from 'next/server';
import nodemailer from 'nodemailer';
import { getAuthEnvironment } from './environment';
import { getEmailDeliveryEnvironment } from './email-delivery-environment';

const emailEnvironment = getEmailDeliveryEnvironment();
const smtpTlsCa = emailEnvironment.tlsCaPath ? readFileSync(emailEnvironment.tlsCaPath) : undefined;
const smtpTransport = nodemailer.createTransport({
  host: emailEnvironment.host,
  port: emailEnvironment.port,
  secure: emailEnvironment.port === 465,
  requireTLS: emailEnvironment.port !== 465,
  auth: {
    user: emailEnvironment.username,
    pass: emailEnvironment.password,
  },
  tls: {
    minVersion: 'TLSv1.2',
    ...(smtpTlsCa ? { ca: smtpTlsCa } : {}),
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  logger: false,
  debug: false,
});

function getTrustedAuthenticationUrl(url: string, purpose: string): URL {
  const authenticationUrl = new URL(url);
  if (
    !['http:', 'https:'].includes(authenticationUrl.protocol) ||
    authenticationUrl.origin !== getAuthEnvironment().baseURL
  ) {
    throw new Error(`${purpose} URL must use the configured authentication origin.`);
  }

  return authenticationUrl;
}

export async function sendVerificationEmail(data: {
  user: { email: string; name: string };
  url: string;
}): Promise<void> {
  const verificationUrl = getTrustedAuthenticationUrl(data.url, 'Email verification');

  await smtpTransport.sendMail({
    from: emailEnvironment.from,
    to: data.user.email,
    subject: 'Verify your CommitmentOS email address',
    text: [
      `Hello ${data.user.name},`,
      '',
      'Verify your email address to finish setting up your CommitmentOS account:',
      verificationUrl.toString(),
      '',
      'If you did not create this account, you can ignore this message.',
    ].join('\n'),
  });
}

export async function sendPasswordResetEmail(data: {
  user: { email: string };
  url: string;
}): Promise<void> {
  const resetUrl = getTrustedAuthenticationUrl(data.url, 'Password reset');
  const message = {
    from: emailEnvironment.from,
    to: data.user.email,
    subject: 'Reset your CommitmentOS password',
    text: [
      'A request was made to reset the password for your CommitmentOS account.',
      '',
      'Use this link within one hour to choose a new password. The link can only be used once:',
      resetUrl.toString(),
      '',
      'If you did not request a password reset, you can ignore this message.',
    ].join('\n'),
  };

  // Do not let SMTP latency reveal whether the requested address has an account.
  after(async () => {
    try {
      await smtpTransport.sendMail(message);
    } catch {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service: 'commitmentos-auth',
          event: 'password_reset_email_delivery_failed',
        }),
      );
    }
  });
}
