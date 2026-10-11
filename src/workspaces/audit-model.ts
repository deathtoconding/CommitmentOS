export const WORKSPACE_AUDIT_EVENT_TYPES = [
  'WORKSPACE_CREATED',
  'MEMBER_ADDED',
  'MEMBER_ROLE_CHANGED',
  'MEMBER_REMOVED',
] as const;

export type WorkspaceAuditEventType = (typeof WORKSPACE_AUDIT_EVENT_TYPES)[number];

export type WorkspaceAuditEventDraft = {
  eventType: WorkspaceAuditEventType;
  targetUserId: string;
  details: Record<string, unknown>;
};

export function workspaceCreatedAuditEvent(ownerUserId: string): WorkspaceAuditEventDraft {
  return {
    eventType: 'WORKSPACE_CREATED',
    targetUserId: ownerUserId,
    details: { role: 'OWNER' },
  };
}

export function workspaceMemberAddedAuditEvent(targetUserId: string): WorkspaceAuditEventDraft {
  return {
    eventType: 'MEMBER_ADDED',
    targetUserId,
    details: { role: 'MEMBER' },
  };
}

export function workspaceMemberRoleChangedAuditEvent(
  targetUserId: string,
  fromRole: 'OWNER' | 'MEMBER',
  toRole: 'OWNER' | 'MEMBER',
): WorkspaceAuditEventDraft {
  return {
    eventType: 'MEMBER_ROLE_CHANGED',
    targetUserId,
    details: { fromRole, toRole },
  };
}

export function workspaceMemberRemovedAuditEvent(
  targetUserId: string,
  role: 'OWNER' | 'MEMBER',
): WorkspaceAuditEventDraft {
  return {
    eventType: 'MEMBER_REMOVED',
    targetUserId,
    details: { role },
  };
}
