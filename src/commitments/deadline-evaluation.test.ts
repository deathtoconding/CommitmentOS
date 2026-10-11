import { describe, expect, it } from 'vitest';
import { COMMITMENT_OVERDUE_SOURCE_STATUSES } from './deadline-evaluation';
import { COMMITMENT_ALLOWED_TRANSITIONS } from './lifecycle';

describe('deadline-to-overdue transition policy', () => {
  it('includes exactly the lifecycle states that permit an OVERDUE transition', () => {
    const expected = Object.entries(COMMITMENT_ALLOWED_TRANSITIONS)
      .filter(([, targets]) => targets.includes('OVERDUE'))
      .map(([status]) => status);

    expect(COMMITMENT_OVERDUE_SOURCE_STATUSES).toEqual(expected);
    expect(COMMITMENT_OVERDUE_SOURCE_STATUSES).toEqual(['OPEN', 'DUE_SOON', 'WAITING', 'BLOCKED']);
  });
});
