import { z } from 'zod';

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());

export const registrationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: emailSchema,
    password: z.string().min(12).max(128),
    callbackURL: z.literal('/login?verified=1').optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    rememberMe: z.boolean().optional(),
    callbackURL: z.literal('/login?verified=1').optional(),
  })
  .strict();

export type RegistrationInput = z.infer<typeof registrationSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
