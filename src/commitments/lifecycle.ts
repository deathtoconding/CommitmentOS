import type { Commitment, CommitmentStatus } from './model';

export const COMMITMENT_ALLOWED_TRANSITIONS: Record<CommitmentStatus, readonly CommitmentStatus[]> =
  {
    DETECTED: ['OPEN', 'DISMISSED'],
    OPEN: ['DUE_SOON', 'WAITING', 'BLOCKED', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
    DUE_SOON: ['WAITING', 'BLOCKED', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
    WAITING: ['OPEN', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
    BLOCKED: ['OPEN', 'DUE_SOON', 'OVERDUE', 'COMPLETED', 'DISMISSED'],
    OVERDUE: ['COMPLETED', 'DISMISSED'],
    COMPLETED: [],
    DISMISSED: [],
  };

export type CommitmentTransitionOptions = {
  /** A caller-provided explicit completion signal; this service does not define its source. */
  completionSignal?: boolean;
  /** Allows callers and tests to supply the time at which the transition occurred. */
  occurredAt?: Date;
};

export type CommitmentTransitionResult =
  | { ok: true; commitment: Commitment }
  | {
      ok: false;
      code: 'INVALID_TRANSITION';
      from: CommitmentStatus;
      to: CommitmentStatus;
    }
  | { ok: false; code: 'COMPLETION_SIGNAL_REQUIRED' };

export function transitionCommitment(
  commitment: Commitment,
  targetStatus: CommitmentStatus,
  options: CommitmentTransitionOptions = {},
): CommitmentTransitionResult {
  const allowedTargets = COMMITMENT_ALLOWED_TRANSITIONS[commitment.status];
  if (!allowedTargets?.includes(targetStatus)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      from: commitment.status,
      to: targetStatus,
    };
  }

  if (
    targetStatus === 'COMPLETED' &&
    options.completionSignal !== true &&
    !commitment.completionEvidence?.trim()
  ) {
    return { ok: false, code: 'COMPLETION_SIGNAL_REQUIRED' };
  }

  return {
    ok: true,
    commitment: {
      ...commitment,
      status: targetStatus,
      ...(targetStatus === 'COMPLETED' ? { completedAt: options.occurredAt ?? new Date() } : {}),
    },
  };
}
