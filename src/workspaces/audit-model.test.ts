import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_AUDIT_EVENT_TYPES,
  workspaceCreatedAuditEvent,
  workspaceMemberAddedAuditEvent,
  workspaceMemberRemovedAuditEvent,
  workspaceMemberRoleChangedAuditEvent,
} from './audit-model';

describe('workspace audit event drafts', () => {
  it('defines the supported immutable workspace events', () => {
    expect(WORKSPACE_AUDIT_EVENT_TYPES).toEqual([
      'WORKSPACE_CREATED',
      'MEMBER_ADDED',
      'MEMBER_ROLE_CHANGED',
      'MEMBER_REMOVED',
    ]);
  });

  it('records workspace creation and membership changes without copying personal details', () => {
    expect(workspaceCreatedAuditEvent('owner-1')).toEqual({
      eventType: 'WORKSPACE_CREATED',
      targetUserId: 'owner-1',
      details: { role: 'OWNER' },
    });
    expect(workspaceMemberAddedAuditEvent('member-1')).toEqual({
      eventType: 'MEMBER_ADDED',
      targetUserId: 'member-1',
      details: { role: 'MEMBER' },
    });
    expect(workspaceMemberRoleChangedAuditEvent('member-1', 'MEMBER', 'OWNER')).toEqual({
      eventType: 'MEMBER_ROLE_CHANGED',
      targetUserId: 'member-1',
      details: { fromRole: 'MEMBER', toRole: 'OWNER' },
    });
    expect(workspaceMemberRemovedAuditEvent('member-1', 'OWNER')).toEqual({
      eventType: 'MEMBER_REMOVED',
      targetUserId: 'member-1',
      details: { role: 'OWNER' },
    });
  });
});
