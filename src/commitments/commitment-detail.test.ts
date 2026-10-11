import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommitmentDetail } from './commitment-detail';
import type { Commitment } from './model';

const commitment: Commitment = {
  id: 'commitment-1',
  workspaceId: 'workspace-1',
  ownerUserId: null,
  sourceMessageId: null,
  sourceMessageRecordId: null,
  commitmentText: 'I will send the revised proposal.',
  normalizedAction: 'Send the revised proposal',
  counterpartyName: null,
  counterpartyEmail: null,
  dueAt: new Date('2026-10-10T12:00:00.000Z'),
  dueTimezone: 'UTC',
  status: 'OVERDUE',
  confidenceScore: null,
  sourceExcerpt: null,
  completionEvidence: null,
  completedAt: null,
  createdBy: 'user-1',
  createdAt: new Date('2026-10-01T12:00:00.000Z'),
  updatedAt: new Date('2026-10-11T12:00:00.000Z'),
};

describe('commitment detail audit timeline attribution', () => {
  it('labels automatic deadline transitions as system activity', () => {
    const html = renderToStaticMarkup(
      createElement(CommitmentDetail, {
        commitment,
        workspaceId: commitment.workspaceId,
        ownerName: null,
        nextAuditCursor: null,
        auditEvents: [
          {
            id: 'audit-system-1',
            actorUserId: null,
            actorType: 'SYSTEM',
            eventType: 'STATUS_CHANGED',
            details: { fromStatus: 'OPEN', toStatus: 'OVERDUE' },
            occurredAt: new Date('2026-10-11T12:00:00.000Z'),
          },
        ],
      }),
    );

    expect(html).toContain('Status changed');
    expect(html).toContain('Open → Overdue');
    expect(html).toContain('Automatically updated by CommitmentOS');
    expect(html).not.toContain('Recorded by a workspace member');
  });

  it('preserves member attribution for user-generated audit events', () => {
    const html = renderToStaticMarkup(
      createElement(CommitmentDetail, {
        commitment,
        workspaceId: commitment.workspaceId,
        ownerName: null,
        nextAuditCursor: null,
        auditEvents: [
          {
            id: 'audit-user-1',
            actorUserId: 'user-1',
            actorType: 'USER',
            eventType: 'CREATED',
            details: {},
            occurredAt: new Date('2026-10-01T12:00:00.000Z'),
          },
        ],
      }),
    );

    expect(html).toContain('Commitment created');
    expect(html).toContain('Recorded by a workspace member');
    expect(html).not.toContain('Automatically updated by CommitmentOS');
  });
});
