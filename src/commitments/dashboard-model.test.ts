import { describe, expect, it } from 'vitest';
import { summarizeWorkspaceCommitments } from './dashboard-model';

describe('summarizeWorkspaceCommitments', () => {
  it('fills absent statuses with zero and derives active totals from stored lifecycle states', () => {
    const summary = summarizeWorkspaceCommitments([
      { status: 'DETECTED', count: 2, unassignedCount: 1 },
      { status: 'OPEN', count: 3, unassignedCount: 1 },
      { status: 'DUE_SOON', count: 1, unassignedCount: 0 },
      { status: 'WAITING', count: 1, unassignedCount: 1 },
      { status: 'BLOCKED', count: 1, unassignedCount: 1 },
      { status: 'OVERDUE', count: 2, unassignedCount: 1 },
      { status: 'COMPLETED', count: 4, unassignedCount: 2 },
      { status: 'DISMISSED', count: 1, unassignedCount: 1 },
    ]);

    expect(summary).toEqual({
      total: 15,
      active: 10,
      unassigned: 5,
      statusCounts: {
        DETECTED: 2,
        OPEN: 3,
        DUE_SOON: 1,
        WAITING: 1,
        BLOCKED: 1,
        OVERDUE: 2,
        COMPLETED: 4,
        DISMISSED: 1,
      },
    });
  });

  it('returns a zero summary for a workspace with no commitment rows', () => {
    expect(summarizeWorkspaceCommitments([])).toEqual({
      total: 0,
      active: 0,
      unassigned: 0,
      statusCounts: {
        DETECTED: 0,
        OPEN: 0,
        DUE_SOON: 0,
        WAITING: 0,
        BLOCKED: 0,
        OVERDUE: 0,
        COMPLETED: 0,
        DISMISSED: 0,
      },
    });
  });

  it.each([
    [{ status: 'OPEN', count: -1, unassignedCount: 0 }],
    [{ status: 'OPEN', count: 1.5, unassignedCount: 0 }],
    [{ status: 'OPEN', count: 1, unassignedCount: 2 }],
  ] as const)('rejects invalid aggregate counts', (row) => {
    expect(() => summarizeWorkspaceCommitments([row])).toThrow(
      'Workspace commitment counts must be nonnegative integers.',
    );
  });
});
