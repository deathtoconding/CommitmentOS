import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('../auth/session', () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));

vi.mock('../db/client', () => ({
  database: { select: mocks.select },
}));

import { requireSession, requireWorkspaceMember, requireWorkspaceRole } from './authorization';

const ownerSession = { user: { id: 'user-owner' } };
const ownerWorkspaceAccess = {
  membership: {
    id: 'member-owner',
    workspaceId: 'workspace-1',
    userId: 'user-owner',
    role: 'OWNER',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  workspace: {
    id: 'workspace-1',
    name: 'Product Team',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

function setMembershipResult(result: unknown[]) {
  mocks.limit.mockResolvedValueOnce(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedSession.mockResolvedValue(ownerSession);
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin });
  mocks.innerJoin.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue([ownerWorkspaceAccess]);
});

describe('workspace authorization helpers', () => {
  it('requires an authenticated session before database access', async () => {
    mocks.getAuthenticatedSession.mockResolvedValueOnce(null);

    const result = await requireSession(new Headers());

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(401);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('allows an owner and a member to access only their matching workspace', async () => {
    const ownerAccess = await requireWorkspaceMember(new Headers(), 'workspace-1');
    expect(ownerAccess.authorized).toBe(true);
    if (ownerAccess.authorized) {
      expect(ownerAccess.value.membership.role).toBe('OWNER');
      expect(ownerAccess.value.workspace.id).toBe('workspace-1');
    }

    setMembershipResult([
      {
        ...ownerWorkspaceAccess,
        membership: { ...ownerWorkspaceAccess.membership, role: 'MEMBER' },
      },
    ]);
    const memberAccess = await requireWorkspaceMember(new Headers(), 'workspace-1');
    expect(memberAccess.authorized).toBe(true);
    if (memberAccess.authorized) {
      expect(memberAccess.value.membership.role).toBe('MEMBER');
    }
  });

  it('hides unknown or non-member workspace IDs', async () => {
    setMembershipResult([]);

    const result = await requireWorkspaceMember(new Headers(), 'invalid-or-unowned-id');

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(404);
    }
  });

  it('allows required roles and rejects members missing the required role', async () => {
    const ownerResult = await requireWorkspaceRole(new Headers(), 'workspace-1', ['OWNER']);
    expect(ownerResult.authorized).toBe(true);

    setMembershipResult([
      {
        ...ownerWorkspaceAccess,
        membership: { ...ownerWorkspaceAccess.membership, role: 'MEMBER' },
      },
    ]);
    const memberResult = await requireWorkspaceRole(new Headers(), 'workspace-1', ['OWNER']);
    expect(memberResult.authorized).toBe(false);
    if (!memberResult.authorized) {
      expect(memberResult.response.status).toBe(403);
    }

    setMembershipResult([
      {
        ...ownerWorkspaceAccess,
        membership: { ...ownerWorkspaceAccess.membership, role: 'MEMBER' },
      },
    ]);
    const allowedMemberResult = await requireWorkspaceRole(new Headers(), 'workspace-1', [
      'OWNER',
      'MEMBER',
    ]);
    expect(allowedMemberResult.authorized).toBe(true);
  });
});
