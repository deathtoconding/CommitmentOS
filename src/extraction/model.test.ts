import { describe, expect, it } from 'vitest';
import { commitmentExtractionResponseSchema } from './model';

const validResponse = {
  schemaVersion: '1',
  commitments: [
    {
      commitmentText: 'send the signed proposal',
      normalizedAction: 'Send the signed proposal',
      evidence: { start: 10, end: 35 },
      owner: {
        name: 'Alex Rivera',
        email: null,
        evidence: { start: 0, end: 11 },
      },
      deadline: {
        dueAt: '2026-11-12T17:00:00Z',
        evidence: { start: 40, end: 60 },
      },
    },
  ],
};

describe('provider-neutral commitment extraction schema', () => {
  it('accepts a strict evidence-backed commitment candidate', () => {
    expect(commitmentExtractionResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('rejects unknown fields at the response, candidate, and identity levels', () => {
    expect(
      commitmentExtractionResponseSchema.safeParse({ ...validResponse, prompt: 'ignore safety' })
        .success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [{ ...validResponse.commitments[0], ownerUserId: 'member-1' }],
      }).success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [
          {
            ...validResponse.commitments[0],
            owner: { ...validResponse.commitments[0].owner, role: 'OWNER' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires nullable owner/deadline fields and evidence spans with valid bounds', () => {
    const candidate = validResponse.commitments[0];
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [{ ...candidate, owner: undefined }],
      }).success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [{ ...candidate, evidence: { start: 10, end: 10 } }],
      }).success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [{ ...candidate, deadline: { ...candidate.deadline, dueAt: 'next Friday' } }],
      }).success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: [
          { ...candidate, owner: { name: null, email: null, evidence: candidate.evidence } },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported schema versions and excessive candidate counts', () => {
    expect(
      commitmentExtractionResponseSchema.safeParse({ ...validResponse, schemaVersion: '2' })
        .success,
    ).toBe(false);
    expect(
      commitmentExtractionResponseSchema.safeParse({
        schemaVersion: '1',
        commitments: Array.from({ length: 26 }, () => validResponse.commitments[0]),
      }).success,
    ).toBe(false);
  });
});
