import { describe, expect, it } from 'vitest';
import { createCommitmentSchema, updateCommitmentSchema } from './schemas';

describe('createCommitmentSchema', () => {
  it('normalizes valid client fields and preserves nullable unknowns', () => {
    const dueAt = '2026-11-02T09:30:00.000Z';
    const result = createCommitmentSchema.parse({
      commitmentText: '  Send the revised proposal  ',
      normalizedAction: '  Send revised proposal  ',
      counterpartyEmail: '  CLIENT@EXAMPLE.COM ',
      dueAt,
      ownerUserId: null,
      sourceMessageRecordId: null,
      counterpartyName: null,
      dueTimezone: null,
      confidenceScore: null,
      sourceExcerpt: null,
    });

    expect(result).toEqual({
      commitmentText: 'Send the revised proposal',
      normalizedAction: 'Send revised proposal',
      counterpartyEmail: 'client@example.com',
      dueAt: new Date(dueAt),
      ownerUserId: null,
      sourceMessageRecordId: null,
      counterpartyName: null,
      dueTimezone: null,
      confidenceScore: null,
      sourceExcerpt: null,
    });
  });

  it('accepts only a workspace-resolvable source record ID, never a client-supplied legacy reference', () => {
    const sourceMessageRecordId = '00000000-0000-4000-8000-000000000001';
    expect(
      createCommitmentSchema.parse({
        commitmentText: 'Send the revised proposal',
        normalizedAction: 'Send revised proposal',
        sourceMessageRecordId,
      }).sourceMessageRecordId,
    ).toBe(sourceMessageRecordId);
    expect(
      createCommitmentSchema.safeParse({
        commitmentText: 'Send the revised proposal',
        normalizedAction: 'Send revised proposal',
        sourceMessageId: 'unscoped-provider-message-id',
      }).success,
    ).toBe(false);
  });

  it('rejects blank descriptions, invalid ranges, malformed dates, and server-owned fields', () => {
    expect(
      createCommitmentSchema.safeParse({
        commitmentText: '   ',
        normalizedAction: 'Send proposal',
      }).success,
    ).toBe(false);
    expect(
      createCommitmentSchema.safeParse({
        commitmentText: 'Send proposal',
        normalizedAction: 'Send proposal',
        confidenceScore: 1.1,
      }).success,
    ).toBe(false);
    expect(
      createCommitmentSchema.safeParse({
        commitmentText: 'Send proposal',
        normalizedAction: 'Send proposal',
        dueAt: 'next Tuesday',
      }).success,
    ).toBe(false);
    expect(
      createCommitmentSchema.safeParse({
        commitmentText: 'Send proposal',
        normalizedAction: 'Send proposal',
        workspaceId: 'another-workspace',
        status: 'OPEN',
        createdBy: 'another-user',
      }).success,
    ).toBe(false);
  });
});

describe('updateCommitmentSchema', () => {
  it('accepts editable fields and lifecycle targets with an explicit completion signal', () => {
    expect(
      updateCommitmentSchema.parse({
        status: 'COMPLETED',
        completionSignal: true,
        completionEvidence: 'Confirmed complete.',
      }),
    ).toEqual({
      status: 'COMPLETED',
      completionSignal: true,
      completionEvidence: 'Confirmed complete.',
    });
    expect(updateCommitmentSchema.parse({ commitmentText: '  Revised commitment  ' })).toEqual({
      commitmentText: 'Revised commitment',
    });
  });

  it('rejects empty updates, standalone completion signals, and unexpected fields', () => {
    expect(updateCommitmentSchema.safeParse({}).success).toBe(false);
    expect(updateCommitmentSchema.safeParse({ completionSignal: true }).success).toBe(false);
    expect(
      updateCommitmentSchema.safeParse({
        status: 'OPEN',
        completionSignal: true,
      }).success,
    ).toBe(false);
    expect(
      updateCommitmentSchema.safeParse({ status: 'OPEN', updatedAt: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});
