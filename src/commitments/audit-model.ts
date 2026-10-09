import type { Commitment } from './model';

export const COMMITMENT_AUDIT_EVENT_TYPES = [
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
] as const;

export type CommitmentAuditEventType = (typeof COMMITMENT_AUDIT_EVENT_TYPES)[number];
export type CommitmentAuditDetails = Record<string, unknown>;

export type CommitmentAuditEventDraft = {
  eventType: CommitmentAuditEventType;
  details: CommitmentAuditDetails;
};

const auditedFields = [
  'commitmentText',
  'normalizedAction',
  'ownerUserId',
  'sourceMessageId',
  'sourceMessageRecordId',
  'counterpartyName',
  'counterpartyEmail',
  'dueAt',
  'dueTimezone',
  'status',
  'confidenceScore',
  'sourceExcerpt',
  'completionEvidence',
] as const;

type AuditedField = (typeof auditedFields)[number];
type AuditComparableCommitment = Pick<Commitment, AuditedField | 'completedAt'>;

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function createCommitmentAuditEvents(
  before: AuditComparableCommitment,
  after: AuditComparableCommitment,
): CommitmentAuditEventDraft[] {
  const changedFields = auditedFields.filter((field) => !valuesEqual(before[field], after[field]));
  if (changedFields.length === 0) {
    return [];
  }

  const events: CommitmentAuditEventDraft[] = [];
  const specializedFields = new Set<AuditedField>([
    'ownerUserId',
    'dueAt',
    'dueTimezone',
    'status',
  ]);
  const editedFields = changedFields.filter((field) => !specializedFields.has(field));

  if (editedFields.length > 0) {
    events.push({ eventType: 'EDITED', details: { changedFields: editedFields } });
  }

  if (changedFields.includes('ownerUserId')) {
    events.push({
      eventType: 'REASSIGNED',
      details: {
        fromOwnerUserId: before.ownerUserId,
        toOwnerUserId: after.ownerUserId,
      },
    });
  }

  if (changedFields.includes('dueAt') || changedFields.includes('dueTimezone')) {
    events.push({
      eventType: 'DEADLINE_CHANGED',
      details: {
        fromDueAt: toIso(before.dueAt),
        toDueAt: toIso(after.dueAt),
        fromTimezone: before.dueTimezone,
        toTimezone: after.dueTimezone,
      },
    });
  }

  if (changedFields.includes('status')) {
    events.push({
      eventType: 'STATUS_CHANGED',
      details: { fromStatus: before.status, toStatus: after.status },
    });

    if (before.status === 'DETECTED' && after.status === 'OPEN') {
      events.push({
        eventType: 'CONFIRMED',
        details: { fromStatus: before.status, toStatus: after.status },
      });
    }

    if (after.status === 'DISMISSED') {
      events.push({ eventType: 'DISMISSED', details: { fromStatus: before.status } });
    }

    if (after.status === 'COMPLETED') {
      events.push({
        eventType: 'COMPLETED',
        details: { completedAt: toIso(after.completedAt) },
      });
    }
  }

  if (changedFields.includes('completionEvidence') && Boolean(after.completionEvidence?.trim())) {
    events.push({
      eventType: 'COMPLETION_EVIDENCE_RECORDED',
      details: { replacedExistingEvidence: Boolean(before.completionEvidence?.trim()) },
    });
  }

  return events;
}

export function commitmentCreatedAuditEvent(commitment: Commitment): CommitmentAuditEventDraft {
  return {
    eventType: 'CREATED',
    details: {
      initialStatus: commitment.status,
      ownerUserId: commitment.ownerUserId,
      dueAt: toIso(commitment.dueAt),
      dueTimezone: commitment.dueTimezone,
    },
  };
}
