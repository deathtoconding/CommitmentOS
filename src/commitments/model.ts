export const COMMITMENT_STATUSES = [
  'DETECTED',
  'OPEN',
  'DUE_SOON',
  'WAITING',
  'BLOCKED',
  'OVERDUE',
  'COMPLETED',
  'DISMISSED',
] as const;

export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export type Commitment = {
  id: string;
  workspaceId: string;
  ownerUserId: string | null;
  sourceMessageId: string | null;
  sourceMessageRecordId: string | null;
  commitmentText: string;
  normalizedAction: string;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  dueAt: Date | null;
  dueTimezone: string | null;
  status: CommitmentStatus;
  confidenceScore: number | null;
  sourceExcerpt: string | null;
  completionEvidence: string | null;
  completedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};
