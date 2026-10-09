import { describe, expect, it } from 'vitest';
import { commitmentAuditEventCursorSchema, commitmentAuditEventLimitSchema } from './schemas';

describe('commitment audit API query schemas', () => {
  it('validates stable cursor fields and bounded page sizes', () => {
    expect(
      commitmentAuditEventCursorSchema.parse({
        id: 'event-1',
        occurredAt: '2026-10-08T12:00:00.000Z',
      }),
    ).toEqual({ id: 'event-1', occurredAt: '2026-10-08T12:00:00.000Z' });
    expect(commitmentAuditEventLimitSchema.parse('50')).toBe(50);
    expect(commitmentAuditEventLimitSchema.parse('100')).toBe(100);
  });

  it('rejects malformed or oversized cursor/limit input', () => {
    expect(
      commitmentAuditEventCursorSchema.safeParse({
        id: 'event-1',
        occurredAt: 'not-a-date',
      }).success,
    ).toBe(false);
    expect(
      commitmentAuditEventCursorSchema.safeParse({
        id: 'event-1',
        occurredAt: '2026-10-08T12:00:00.000Z',
        workspaceId: 'another-workspace',
      }).success,
    ).toBe(false);
    expect(commitmentAuditEventLimitSchema.safeParse('0').success).toBe(false);
    expect(commitmentAuditEventLimitSchema.safeParse('101').success).toBe(false);
  });
});
