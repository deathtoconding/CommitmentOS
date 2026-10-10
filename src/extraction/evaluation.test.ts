import { describe, expect, it } from 'vitest';
import { evaluateExtractionCases } from './evaluation';

describe('extraction evaluation metrics', () => {
  it('reports commitment precision/recall, source-level false positives, and field accuracy', () => {
    const metrics = evaluateExtractionCases([
      {
        id: 'correct',
        expected: [
          {
            commitmentText: 'send the report',
            ownerUserId: 'member-one',
            dueAt: '2026-11-12T17:00:00Z',
          },
        ],
        predicted: [
          {
            commitmentText: 'Send   the report',
            normalizedAction: 'Send the report',
            ownerUserId: 'member-one',
            dueAt: new Date('2026-11-12T17:00:00Z'),
            evidence: { start: 0, end: 1 },
            ownerEvidence: null,
            deadlineEvidence: null,
            reviewStatus: 'PENDING_HUMAN_REVIEW',
          },
        ],
      },
      {
        id: 'false-positive',
        expected: [],
        predicted: [
          {
            commitmentText: 'consider a workshop',
            normalizedAction: 'Consider a workshop',
            ownerUserId: null,
            dueAt: null,
            evidence: { start: 0, end: 1 },
            ownerEvidence: null,
            deadlineEvidence: null,
            reviewStatus: 'PENDING_HUMAN_REVIEW',
          },
        ],
      },
      {
        id: 'missed',
        expected: [{ commitmentText: 'approve the request', ownerUserId: null, dueAt: null }],
        predicted: [],
      },
      { id: 'true-negative', expected: [], predicted: [] },
    ]);

    expect(metrics).toEqual({
      commitmentPrecision: { value: 0.5, numerator: 1, denominator: 2 },
      commitmentRecall: { value: 0.5, numerator: 1, denominator: 2 },
      falsePositiveRate: { value: 0.5, numerator: 1, denominator: 2 },
      ownerAccuracy: { value: 1, numerator: 1, denominator: 1 },
      deadlineAccuracy: { value: 1, numerator: 1, denominator: 1 },
      commitmentCounts: { truePositives: 1, falsePositives: 1, falseNegatives: 1 },
      sourceCounts: { truePositives: 1, falsePositives: 1, falseNegatives: 1, trueNegatives: 1 },
    });
  });

  it('uses null for undefined rates when the fixture set has no denominator', () => {
    const metrics = evaluateExtractionCases([]);
    expect(metrics.commitmentPrecision.value).toBeNull();
    expect(metrics.commitmentRecall.value).toBeNull();
    expect(metrics.falsePositiveRate.value).toBeNull();
    expect(metrics.ownerAccuracy.value).toBeNull();
    expect(metrics.deadlineAccuracy.value).toBeNull();
  });
});
