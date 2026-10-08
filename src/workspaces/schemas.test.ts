import { describe, expect, it } from 'vitest';
import { createWorkspaceSchema } from './schemas';

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
