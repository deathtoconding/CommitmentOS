import 'server-only';
import { readFileSync } from 'node:fs';
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

export async function sendVerificationEmail(data: {
  user: { email: string; name: string };
  url: string;
}): Promise<void> {
  const verificationUrl = new URL(data.url);
  if (
    !['http:', 'https:'].includes(verificationUrl.protocol) ||
    verificationUrl.origin !== getAuthEnvironment().baseURL
  ) {
    throw new Error('Email verification URL must use the configured authentication origin.');
  }

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
