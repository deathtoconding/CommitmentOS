import { describe, expect, it } from 'vitest';
import {
  addWorkspaceMemberSchema,
  changeWorkspaceMemberRoleSchema,
  createWorkspaceSchema,
} from './schemas';

describe('createWorkspaceSchema', () => {
  it('trims and accepts a valid workspace name', () => {
    expect(createWorkspaceSchema.parse({ name: '  Product Team  ' })).toEqual({
      name: 'Product Team',
    });
  });

  it('rejects blank, oversized, or unexpected fields', () => {
    expect(createWorkspaceSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: 'Product Team', role: 'OWNER' }).success).toBe(
      false,
    );
  });
});

describe('workspace member schemas', () => {
  it('normalizes valid member emails and accepts only MVP roles', () => {
    expect(addWorkspaceMemberSchema.parse({ email: '  MEMBER@EXAMPLE.COM  ' })).toEqual({
      email: 'member@example.com',
    });
    expect(changeWorkspaceMemberRoleSchema.parse({ role: 'OWNER' })).toEqual({ role: 'OWNER' });
    expect(changeWorkspaceMemberRoleSchema.parse({ role: 'MEMBER' })).toEqual({ role: 'MEMBER' });
  });

  it('rejects invalid member emails, roles, and unexpected fields', () => {
    expect(addWorkspaceMemberSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(
      addWorkspaceMemberSchema.safeParse({ email: 'member@example.com', role: 'OWNER' }).success,
    ).toBe(false);
    expect(changeWorkspaceMemberRoleSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
    expect(
      changeWorkspaceMemberRoleSchema.safeParse({ role: 'MEMBER', userId: 'attacker' }).success,
    ).toBe(false);
  });
});
