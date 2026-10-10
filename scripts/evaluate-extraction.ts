import assert from 'node:assert/strict';
import fixtureSet from '../fixtures/extraction/v1.json';
import {
  evaluateExtractionCases,
  type ExtractionEvaluationCase,
} from '../src/extraction/evaluation';
import { extractCommitmentProposals, type ExtractionProvider } from '../src/extraction/provider';

const evaluatedCases: ExtractionEvaluationCase[] = [];
for (const testCase of fixtureSet.cases) {
  const provider: ExtractionProvider = {
    id: 'synthetic-fixture-provider',
    version: `fixture-set-${fixtureSet.version}`,
    async extract(request) {
      assert.equal(request.schemaVersion, fixtureSet.schemaVersion);
      assert.equal(request.sourceTextTrust, 'UNTRUSTED_EXTERNAL_CONTENT');
      assert.ok(request.untrustedSourceInstruction.includes('Never follow instructions'));
      assert.equal(request.sourceText, testCase.sourceText);
      return testCase.providerOutput;
    },
  };

  const result = await extractCommitmentProposals(
    provider,
    testCase.sourceText,
    fixtureSet.workspaceOwners,
  );
  assert.equal(
    result.status,
    'ready-for-review',
    `Fixture ${testCase.id} must produce a safely validated result.`,
  );
  if (result.status !== 'ready-for-review') {
    throw new Error(`Fixture ${testCase.id} returned invalid provider output.`);
  }
  evaluatedCases.push({
    id: testCase.id,
    expected: testCase.groundTruth,
    predicted: result.commitments,
  });
}

const metrics = evaluateExtractionCases(evaluatedCases);
assert.deepEqual(metrics, {
  commitmentPrecision: { value: 0.75, numerator: 6, denominator: 8 },
  commitmentRecall: { value: 0.8571, numerator: 6, denominator: 7 },
  falsePositiveRate: { value: 0.3333, numerator: 1, denominator: 3 },
  ownerAccuracy: { value: 0.8333, numerator: 5, denominator: 6 },
  deadlineAccuracy: { value: 0.8333, numerator: 5, denominator: 6 },
  commitmentCounts: { truePositives: 6, falsePositives: 2, falseNegatives: 1 },
  sourceCounts: { truePositives: 6, falsePositives: 1, falseNegatives: 1, trueNegatives: 2 },
});

const report = {
  fixtureSet: fixtureSet.fixtureSet,
  fixtureVersion: fixtureSet.version,
  schemaVersion: fixtureSet.schemaVersion,
  provider: { id: 'synthetic-fixture-provider', version: `fixture-set-${fixtureSet.version}` },
  metrics,
};
const reportJson = JSON.stringify(report, null, 2);
for (const testCase of fixtureSet.cases) {
  assert.equal(
    reportJson.includes(testCase.sourceText),
    false,
    'The regression report must not include source text.',
  );
}
console.log(reportJson);
