import { describe, expect, it } from 'vitest';
import { getEmailDeliveryEnvironment } from './email-delivery-environment';

const baseEnvironment = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASSWORD: 'a-long-enough-smtp-password',
  EMAIL_FROM: 'NOREPLY@EXAMPLE.TEST',
};

describe('getEmailDeliveryEnvironment', () => {
  it('parses required SMTP settings and accepts an empty optional CA path', () => {
    expect(getEmailDeliveryEnvironment({ ...baseEnvironment, SMTP_TLS_CA: '  ' })).toEqual({
      host: 'smtp.example.test',
      port: 587,
      username: 'mailer',
      password: 'a-long-enough-smtp-password',
      from: 'noreply@example.test',
    });
  });

  it('trims a configured CA bundle path', () => {
    expect(
      getEmailDeliveryEnvironment({
        ...baseEnvironment,
        SMTP_TLS_CA: ' /etc/ssl/private/smtp.pem ',
      }).tlsCaPath,
    ).toBe('/etc/ssl/private/smtp.pem');
  });

  it.each([
    ['SMTP_HOST', ''],
    ['SMTP_PORT', '65536'],
    ['SMTP_USER', ''],
    ['SMTP_PASSWORD', 'short'],
    ['EMAIL_FROM', 'not-an-email'],
  ])('rejects invalid %s configuration', (key, value) => {
    expect(() => getEmailDeliveryEnvironment({ ...baseEnvironment, [key]: value })).toThrow(
      'Email delivery requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM.',
    );
  });
});
