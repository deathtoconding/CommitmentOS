import { describe, expect, it } from 'vitest';
import { commitmentStatusLabel, formatCommitmentDeadline } from './presentation';

describe('formatCommitmentDeadline', () => {
  it('labels an unknown deadline without inventing a value', () => {
    expect(formatCommitmentDeadline(null, null)).toBe('No deadline set');
  });

  it('formats the instant in the supplied IANA timezone', () => {
    const dueAt = new Date('2026-11-02T09:30:00.000Z');
    const formatted = formatCommitmentDeadline(dueAt, 'Europe/Amsterdam');

    expect(formatted).toContain('02 Nov 2026');
    expect(formatted).toContain('10:30');
    expect(formatted).not.toContain('09:30');
  });

  it('handles daylight-saving transitions using the timezone database', () => {
    const beforeSpringTransition = new Date('2026-03-29T00:30:00.000Z');
    const afterSpringTransition = new Date('2026-03-29T01:30:00.000Z');

    expect(formatCommitmentDeadline(beforeSpringTransition, 'Europe/Amsterdam')).toContain('01:30');
    expect(formatCommitmentDeadline(afterSpringTransition, 'Europe/Amsterdam')).toContain('03:30');
  });

  it('falls back to an explicitly labeled UTC instant for an invalid timezone', () => {
    const dueAt = new Date('2026-01-02T12:34:00.000Z');

    expect(formatCommitmentDeadline(dueAt, 'Not/A-Timezone')).toContain('02 Jan 2026, 12:34 UTC');
  });

  it('renders commitment statuses as readable labels without changing their meaning', () => {
    expect(commitmentStatusLabel('DETECTED')).toBe('Detected');
    expect(commitmentStatusLabel('DUE_SOON')).toBe('Due Soon');
    expect(commitmentStatusLabel('OVERDUE')).toBe('Overdue');
  });
});
