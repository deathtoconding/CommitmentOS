import { describe, expect, it } from 'vitest';
import { resolveActiveWorkspace } from './active-workspace';
import type { UserWorkspace } from './queries';

const memberships: UserWorkspace[] = [
  {
    id: 'workspace-a',
    name: 'Product',
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    role: 'OWNER',
  },
  {
    id: 'workspace-b',
    name: 'Operations',
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    role: 'MEMBER',
  },
];

describe('resolveActiveWorkspace', () => {
  it('defaults to the first workspace returned by the membership query', () => {
    expect(resolveActiveWorkspace(memberships, undefined)).toEqual({
      status: 'selected',
      workspace: memberships[0],
    });
  });

  it('allows switching only to a workspace in the authenticated membership list', () => {
    expect(resolveActiveWorkspace(memberships, 'workspace-b')).toEqual({
      status: 'selected',
      workspace: memberships[1],
    });
  });

  it('rejects an unknown or non-member workspace instead of falling back', () => {
    expect(resolveActiveWorkspace(memberships, 'another-workspace')).toEqual({
      status: 'not-member',
    });
  });

  it('distinguishes a user with no memberships from an unauthorized selection', () => {
    expect(resolveActiveWorkspace([], undefined)).toEqual({ status: 'empty' });
    expect(resolveActiveWorkspace([], 'workspace-a')).toEqual({ status: 'not-member' });
  });
});
