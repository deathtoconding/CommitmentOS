import { describe, expect, it } from 'vitest';
import {
  COMMITMENT_AUDIT_EVENT_TYPES,
  commitmentCreatedAuditEvent,
  createCommitmentAuditEvents,
} from './audit-model';
import type { Commitment } from './model';

const eventTime = new Date('2026-10-08T12:00:00.000Z');

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'commitment-1',
    workspaceId: 'workspace-1',
    ownerUserId: null,
    sourceMessageId: null,
    commitmentText: 'Send the revised proposal',
    normalizedAction: 'Send revised proposal',
    counterpartyName: null,
    counterpartyEmail: null,
    dueAt: null,
    dueTimezone: null,
    status: 'DETECTED',
    confidenceScore: null,
    sourceExcerpt: null,
    completionEvidence: null,
    completedAt: null,
    createdBy: 'user-1',
    createdAt: eventTime,
    updatedAt: eventTime,
    ...overrides,
  };
}

describe('commitment audit event classification', () => {
  it('declares the required current and future consequential event types', () => {
    expect(COMMITMENT_AUDIT_EVENT_TYPES).toEqual([
      'CREATED',
      'EDITED',
      'CONFIRMED',
      'DISMISSED',
      'REASSIGNED',
      'DEADLINE_CHANGED',
      'STATUS_CHANGED',
      'COMPLETED',
      'COMPLETION_EVIDENCE_RECORDED',
      'FOLLOW_UP_GENERATED',
      'APPROVED',
      'SENT',
    ]);
  });

  it('records creation metadata without copying commitment text or source excerpts', () => {
    const source = commitment({ sourceExcerpt: 'Sensitive message excerpt.' });
    const event = commitmentCreatedAuditEvent(source);

    expect(event).toEqual({
      eventType: 'CREATED',
      details: { initialStatus: 'DETECTED', ownerUserId: null, dueAt: null, dueTimezone: null },
    });
    expect(JSON.stringify(event)).not.toContain(source.commitmentText);
    expect(JSON.stringify(event)).not.toContain(source.sourceExcerpt);
  });

  it('records edited field names without duplicating sensitive content', () => {
    const before = commitment();
    const after = commitment({
      commitmentText: 'A new private commitment description.',
      sourceExcerpt: 'A private excerpt from the source message.',
    });

    expect(createCommitmentAuditEvents(before, after)).toEqual([
      { eventType: 'EDITED', details: { changedFields: ['commitmentText', 'sourceExcerpt'] } },
    ]);
    const serialized = JSON.stringify(createCommitmentAuditEvents(before, after));
    expect(serialized).not.toContain(after.commitmentText);
    expect(serialized).not.toContain(after.sourceExcerpt);
  });

  it('records reassignment and deadline changes with their old and new values', () => {
    const before = commitment({ dueAt: new Date('2026-11-01T09:00:00.000Z') });
    const after = commitment({
      ownerUserId: 'user-2',
      dueAt: new Date('2026-11-02T09:30:00.000Z'),
      dueTimezone: 'Europe/Brussels',
    });

    expect(createCommitmentAuditEvents(before, after)).toEqual([
      {
        eventType: 'REASSIGNED',
        details: { fromOwnerUserId: null, toOwnerUserId: 'user-2' },
      },
      {
        eventType: 'DEADLINE_CHANGED',
        details: {
          fromDueAt: '2026-11-01T09:00:00.000Z',
          toDueAt: '2026-11-02T09:30:00.000Z',
          fromTimezone: null,
          toTimezone: 'Europe/Brussels',
        },
      },
    ]);
  });

  it('records status, confirmation, dismissal, and completion as distinct consequential events', () => {
    const detected = commitment();
    const opened = commitment({ status: 'OPEN' });
    expect(createCommitmentAuditEvents(detected, opened)).toEqual([
      { eventType: 'STATUS_CHANGED', details: { fromStatus: 'DETECTED', toStatus: 'OPEN' } },
      { eventType: 'CONFIRMED', details: { fromStatus: 'DETECTED', toStatus: 'OPEN' } },
    ]);

    const dismissed = commitment({ status: 'DISMISSED' });
    expect(
      createCommitmentAuditEvents(detected, dismissed).map((event) => event.eventType),
    ).toEqual(['STATUS_CHANGED', 'DISMISSED']);

    const completed = commitment({ status: 'COMPLETED', completedAt: eventTime });
    expect(createCommitmentAuditEvents(opened, completed)).toEqual([
      { eventType: 'STATUS_CHANGED', details: { fromStatus: 'OPEN', toStatus: 'COMPLETED' } },
      { eventType: 'COMPLETED', details: { completedAt: eventTime.toISOString() } },
    ]);
  });

  it('records evidence arrival without storing the evidence content and ignores no-op updates', () => {
    const before = commitment();
    const after = commitment({ completionEvidence: 'A private completion confirmation.' });
    const events = createCommitmentAuditEvents(before, after);

    expect(events).toEqual([
      { eventType: 'EDITED', details: { changedFields: ['completionEvidence'] } },
      { eventType: 'COMPLETION_EVIDENCE_RECORDED', details: { replacedExistingEvidence: false } },
    ]);
    expect(JSON.stringify(events)).not.toContain(after.completionEvidence);
    expect(createCommitmentAuditEvents(before, before)).toEqual([]);
  });
});
