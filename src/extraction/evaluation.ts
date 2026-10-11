import type { CommitmentProposal } from './model';

export type ExtractionGroundTruth = {
  commitmentText: string;
  ownerUserId: string | null;
  dueAt: string | null;
};

export type ExtractionEvaluationCase = {
  id: string;
  expected: readonly ExtractionGroundTruth[];
  predicted: readonly CommitmentProposal[];
};

export type ExtractionMetric = {
  value: number | null;
  numerator: number;
  denominator: number;
};

export type ExtractionEvaluationMetrics = {
  commitmentPrecision: ExtractionMetric;
  commitmentRecall: ExtractionMetric;
  falsePositiveRate: ExtractionMetric;
  ownerAccuracy: ExtractionMetric;
  deadlineAccuracy: ExtractionMetric;
  commitmentCounts: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  };
  sourceCounts: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
  };
};

function normalizeCommitmentText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeInstant(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function metric(numerator: number, denominator: number): ExtractionMetric {
  return {
    value: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)),
    numerator,
    denominator,
  };
}

export function evaluateExtractionCases(
  cases: readonly ExtractionEvaluationCase[],
): ExtractionEvaluationMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let sourceTruePositives = 0;
  let sourceFalsePositives = 0;
  let sourceFalseNegatives = 0;
  let sourceTrueNegatives = 0;
  let ownerCorrect = 0;
  let ownerCount = 0;
  let deadlineCorrect = 0;
  let deadlineCount = 0;

  for (const testCase of cases) {
    const unmatchedExpected = new Set(testCase.expected.map((_item, index) => index));
    for (const prediction of testCase.predicted) {
      const predictionText = normalizeCommitmentText(prediction.commitmentText);
      const matchedIndex = testCase.expected.findIndex(
        (expected, index) =>
          unmatchedExpected.has(index) &&
          normalizeCommitmentText(expected.commitmentText) === predictionText,
      );
      if (matchedIndex < 0) {
        falsePositives += 1;
        continue;
      }

      const expected = testCase.expected[matchedIndex];
      unmatchedExpected.delete(matchedIndex);
      truePositives += 1;
      ownerCount += 1;
      deadlineCount += 1;
      if (expected?.ownerUserId === prediction.ownerUserId) ownerCorrect += 1;
      if (normalizeInstant(expected?.dueAt ?? null) === normalizeInstant(prediction.dueAt)) {
        deadlineCorrect += 1;
      }
    }
    falseNegatives += unmatchedExpected.size;

    const expectedHasCommitment = testCase.expected.length > 0;
    const predictedHasCommitment = testCase.predicted.length > 0;
    if (expectedHasCommitment && predictedHasCommitment) sourceTruePositives += 1;
    else if (expectedHasCommitment) sourceFalseNegatives += 1;
    else if (predictedHasCommitment) sourceFalsePositives += 1;
    else sourceTrueNegatives += 1;
  }

  const sourceFalsePositiveDenominator = sourceFalsePositives + sourceTrueNegatives;
  return {
    commitmentPrecision: metric(truePositives, truePositives + falsePositives),
    commitmentRecall: metric(truePositives, truePositives + falseNegatives),
    falsePositiveRate: metric(sourceFalsePositives, sourceFalsePositiveDenominator),
    ownerAccuracy: metric(ownerCorrect, ownerCount),
    deadlineAccuracy: metric(deadlineCorrect, deadlineCount),
    commitmentCounts: { truePositives, falsePositives, falseNegatives },
    sourceCounts: {
      truePositives: sourceTruePositives,
      falsePositives: sourceFalsePositives,
      falseNegatives: sourceFalseNegatives,
      trueNegatives: sourceTrueNegatives,
    },
  };
}
