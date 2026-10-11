import { COMMITMENT_STATUSES, type CommitmentStatus } from './model';

export type WorkspaceCommitmentStatusCount = {
  status: CommitmentStatus;
  count: number;
  unassignedCount: number;
};

export type WorkspaceCommitmentSummary = {
  total: number;
  active: number;
  unassigned: number;
  statusCounts: Record<CommitmentStatus, number>;
};

const terminalStatuses = new Set<CommitmentStatus>(['COMPLETED', 'DISMISSED']);

export function summarizeWorkspaceCommitments(
  rows: readonly WorkspaceCommitmentStatusCount[],
): WorkspaceCommitmentSummary {
  const statusCounts = Object.fromEntries(
    COMMITMENT_STATUSES.map((status) => [status, 0]),
  ) as Record<CommitmentStatus, number>;
  let unassigned = 0;

  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.count) ||
      row.count < 0 ||
      !Number.isSafeInteger(row.unassignedCount) ||
      row.unassignedCount < 0 ||
      row.unassignedCount > row.count
    ) {
      throw new TypeError('Workspace commitment counts must be nonnegative integers.');
    }

    statusCounts[row.status] += row.count;
    if (!terminalStatuses.has(row.status)) {
      unassigned += row.unassignedCount;
    }
  }

  const total = COMMITMENT_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0);
  const terminal = statusCounts.COMPLETED + statusCounts.DISMISSED;

  return {
    total,
    active: total - terminal,
    unassigned,
    statusCounts,
  };
}
