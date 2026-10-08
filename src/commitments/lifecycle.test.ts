import { describe, expect, it } from 'vitest';
import { COMMITMENT_ALLOWED_TRANSITIONS, transitionCommitment } from './lifecycle';
import { COMMITMENT_STATUSES, type Commitment, type CommitmentStatus } from './model';

const expectedTransitions: Record<CommitmentStatus, readonly CommitmentStatus[]> = {
  DETECTED: ['OPEN', 'DISMISSED'],
  OPEN: ['DUE_SOON', 'WAITING', 'BLOCKED', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
  DUE_SOON: ['WAITING', 'BLOCKED', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
  WAITING: ['OPEN', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
  BLOCKED: ['OPEN', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
  OVERDUE: ['COMPLETED', 'DISMISSED'],
  COMPLETED: [],
  DISMISSED: [],
};

const transitionTime = new Date('2026-10-08T12:00:00.000Z');

function commitmentIn(status: CommitmentStatus, overrides: Partial<Commitment> = {}): Commitment {
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
    status,
    confidenceScore: null,
    sourceExcerpt: null,
    completionEvidence: null,
    completedAt: null,
    createdBy: 'user-1',
    createdAt: transitionTime,
    updatedAt: transitionTime,
    ...overrides,
  };
}

describe('commitment lifecycle transition matrix', () => {
  it('matches the complete explicit transition allow-list', () => {
    expect(COMMITMENT_ALLOWED_TRANSITIONS).toEqual(expectedTransitions);
  });

  for (const from of COMMITMENT_STATUSES) {
    for (const to of COMMITMENT_STATUSES) {
      const allowed = expectedTransitions[from].includes(to);

      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        const source = commitmentIn(from);
        const result = transitionCommitment(source, to, {
          completionSignal: to === 'COMPLETED',
          occurredAt: transitionTime,
        });

        if (!allowed) {
          expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION', from, to });
          return;
        }

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.commitment.status).toBe(to);
          expect(result.commitment.id).toBe(source.id);
          expect(result.commitment.workspaceId).toBe(source.workspaceId);
          expect(source.status).toBe(from);
          if (to === 'COMPLETED') {
            expect(result.commitment.completedAt).toEqual(transitionTime);
            expect(result.commitment.completionEvidence).toBeNull();
          } else {
            expect(result.commitment.completedAt).toBeNull();
          }
        }
      });
    }
  }

  it('requires an explicit completion signal or existing evidence', () => {
    for (const from of COMMITMENT_STATUSES) {
      if (!expectedTransitions[from].includes('COMPLETED')) continue;

      expect(transitionCommitment(commitmentIn(from), 'COMPLETED')).toEqual({
        ok: false,
        code: 'COMPLETION_SIGNAL_REQUIRED',
      });
    }
  });

  it('accepts pre-existing evidence without inventing or altering an evidence mechanism', () => {
    const source = commitmentIn('OPEN', { completionEvidence: 'Confirmed by the counterparty.' });
    const result = transitionCommitment(source, 'COMPLETED', { occurredAt: transitionTime });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commitment.status).toBe('COMPLETED');
      expect(result.commitment.completionEvidence).toBe('Confirmed by the counterparty.');
      expect(result.commitment.completedAt).toEqual(transitionTime);
    }
  });

  it('does not treat blank evidence as a completion signal', () => {
    const source = commitmentIn('OPEN', { completionEvidence: '   ' });
    expect(transitionCommitment(source, 'COMPLETED')).toEqual({
      ok: false,
      code: 'COMPLETION_SIGNAL_REQUIRED',
    });
  });

  it('does not infer DUE_SOON or OVERDUE from the clock or due date', () => {
    const noDeadline = commitmentIn('OPEN');
    const overdueDeadline = commitmentIn('OPEN', { dueAt: new Date('2020-01-01T00:00:00.000Z') });

    const sameState = transitionCommitment(noDeadline, 'OPEN');
    expect(sameState.ok).toBe(false);
    if (!sameState.ok) {
      expect(sameState.code).toBe('INVALID_TRANSITION');
    }

    expect(transitionCommitment(overdueDeadline, 'DUE_SOON').ok).toBe(true);
    expect(transitionCommitment(overdueDeadline, 'OVERDUE').ok).toBe(true);
  });
});
