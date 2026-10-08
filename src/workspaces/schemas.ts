import { z } from 'zod';

export const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const addWorkspaceMemberSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export const changeWorkspaceMemberRoleSchema = z
  .object({
    role: z.enum(['OWNER', 'MEMBER']),
  })
  .strict();

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type AddWorkspaceMemberInput = z.infer<typeof addWorkspaceMemberSchema>;
export type ChangeWorkspaceMemberRoleInput = z.infer<typeof changeWorkspaceMemberRoleSchema>;
