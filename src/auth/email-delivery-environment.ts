import { z } from 'zod';

const emailDeliveryEnvironmentSchema = z.object({
  SMTP_HOST: z.string().trim().min(1).max(255),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
  SMTP_USER: z.string().trim().min(1).max(255),
  SMTP_PASSWORD: z.string().min(16).max(512),
  EMAIL_FROM: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  SMTP_TLS_CA: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
});

export type EmailDeliveryEnvironment = {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  tlsCaPath?: string;
};

export function getEmailDeliveryEnvironment(
  environment: Record<string, string | undefined> = process.env,
): EmailDeliveryEnvironment {
  const result = emailDeliveryEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(
      'Email delivery requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM.',
    );
  }

  return {
    host: result.data.SMTP_HOST,
    port: result.data.SMTP_PORT,
    username: result.data.SMTP_USER,
    password: result.data.SMTP_PASSWORD,
    from: result.data.EMAIL_FROM,
    ...(result.data.SMTP_TLS_CA ? { tlsCaPath: result.data.SMTP_TLS_CA } : {}),
  };
}
