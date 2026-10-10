import {
  commitmentExtractionResponseSchema,
  EXTRACTION_SCHEMA_VERSION,
  EXTRACTION_UNTRUSTED_SOURCE_INSTRUCTION,
  MAX_EXTRACTION_SOURCE_CHARS,
  type CommitmentProposal,
  type EvidenceSpan,
  type WorkspaceOwner,
} from './model';

export const EXTRACTION_PROVIDER_TIMEOUT_MS = 30_000;

export type ExtractionProviderRequest = {
  schemaVersion: typeof EXTRACTION_SCHEMA_VERSION;
  sourceText: string;
  sourceTextTrust: 'UNTRUSTED_EXTERNAL_CONTENT';
  untrustedSourceInstruction: typeof EXTRACTION_UNTRUSTED_SOURCE_INSTRUCTION;
  signal: AbortSignal;
};

export type ExtractionProvider = {
  readonly id: string;
  readonly version: string;
  extract(request: ExtractionProviderRequest): Promise<unknown>;
};

export class ExtractionSourceTooLargeError extends Error {
  constructor() {
    super('The source text exceeds the configured in-memory extraction limit.');
    this.name = 'ExtractionSourceTooLargeError';
  }
}

export type ExtractionValidationResult =
  | {
      status: 'ready-for-review';
      schemaVersion: typeof EXTRACTION_SCHEMA_VERSION;
      commitments: CommitmentProposal[];
    }
  | {
      status: 'invalid-provider-output';
      errorCode: 'INVALID_EXTRACTION_OUTPUT';
      commitments: [];
    }
  | {
      status: 'provider-failed';
      errorCode: 'EXTRACTION_PROVIDER_FAILURE' | 'EXTRACTION_PROVIDER_TIMEOUT';
      commitments: [];
    };

function comparableText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isUtf16Boundary(sourceText: string, offset: number): boolean {
  if (offset <= 0 || offset >= sourceText.length) return true;
  const previousCodeUnit = sourceText.charCodeAt(offset - 1);
  const currentCodeUnit = sourceText.charCodeAt(offset);
  return !(
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    currentCodeUnit >= 0xdc00 &&
    currentCodeUnit <= 0xdfff
  );
}

function readEvidence(sourceText: string, span: EvidenceSpan): string | null {
  if (
    span.start < 0 ||
    span.end > sourceText.length ||
    span.end <= span.start ||
    !isUtf16Boundary(sourceText, span.start) ||
    !isUtf16Boundary(sourceText, span.end)
  ) {
    return null;
  }
  return sourceText.slice(span.start, span.end);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function containsName(text: string, name: string): boolean {
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegularExpression(name.trim())}(?:$|[^\\p{L}\\p{N}])`,
    'iu',
  );
  return pattern.test(text);
}

function memberIsMentioned(text: string, member: WorkspaceOwner): boolean {
  return containsName(text, member.name) || text.toLowerCase().includes(member.email.toLowerCase());
}

function resolveOwner(
  sourceText: string,
  candidate: NonNullable<
    ReturnType<typeof commitmentExtractionResponseSchema.parse>['commitments'][number]['owner']
  >,
  workspaceOwners: readonly WorkspaceOwner[],
): string | null {
  const evidence = readEvidence(sourceText, candidate.evidence);
  if (!evidence) return null;
  if (candidate.name !== null && !containsName(evidence, candidate.name)) return null;
  if (candidate.email !== null && !evidence.toLowerCase().includes(candidate.email.toLowerCase())) {
    return null;
  }

  const identityMatches = workspaceOwners.filter((member) => {
    const emailMatches =
      candidate.email === null || member.email.trim().toLowerCase() === candidate.email;
    const nameMatches =
      candidate.name === null || comparableText(member.name) === comparableText(candidate.name);
    return emailMatches && nameMatches;
  });
  if (identityMatches.length !== 1) return null;

  const mentionedMembers = workspaceOwners.filter((member) => memberIsMentioned(evidence, member));
  if (mentionedMembers.length !== 1 || mentionedMembers[0]?.userId !== identityMatches[0]?.userId) {
    return null;
  }

  return identityMatches[0]?.userId ?? null;
}

function resolveDeadline(
  sourceText: string,
  candidate: NonNullable<
    ReturnType<typeof commitmentExtractionResponseSchema.parse>['commitments'][number]['deadline']
  >,
): Date | null {
  const evidence = readEvidence(sourceText, candidate.evidence);
  if (!evidence || !evidence.includes(candidate.dueAt)) return null;
  const deadline = new Date(candidate.dueAt);
  return Number.isNaN(deadline.getTime()) ? null : deadline;
}

export function validateAndResolveExtraction(
  sourceText: string,
  rawOutput: unknown,
  workspaceOwners: readonly WorkspaceOwner[],
): ExtractionValidationResult {
  if (sourceText.length > MAX_EXTRACTION_SOURCE_CHARS) {
    throw new ExtractionSourceTooLargeError();
  }

  const parsed = commitmentExtractionResponseSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      status: 'invalid-provider-output',
      errorCode: 'INVALID_EXTRACTION_OUTPUT',
      commitments: [],
    };
  }

  const commitments: CommitmentProposal[] = [];
  const seenCommitments = new Set<string>();
  for (const candidate of parsed.data.commitments) {
    const evidence = readEvidence(sourceText, candidate.evidence);
    const normalizedText = comparableText(candidate.commitmentText);
    const normalizedAction = comparableText(candidate.normalizedAction);
    if (
      !evidence ||
      !normalizedText ||
      normalizedAction !== normalizedText ||
      !comparableText(evidence).includes(normalizedText)
    ) {
      continue;
    }
    if (seenCommitments.has(normalizedText)) continue;
    seenCommitments.add(normalizedText);

    const ownerUserId = candidate.owner
      ? resolveOwner(sourceText, candidate.owner, workspaceOwners)
      : null;
    const dueAt = candidate.deadline ? resolveDeadline(sourceText, candidate.deadline) : null;

    commitments.push({
      commitmentText: candidate.commitmentText,
      normalizedAction: candidate.normalizedAction,
      ownerUserId,
      dueAt,
      evidence: candidate.evidence,
      ownerEvidence: ownerUserId === null ? null : (candidate.owner?.evidence ?? null),
      deadlineEvidence: dueAt === null ? null : (candidate.deadline?.evidence ?? null),
      reviewStatus: 'PENDING_HUMAN_REVIEW',
    });
  }

  return {
    status: 'ready-for-review',
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    commitments,
  };
}

/**
 * Calls only the supplied provider port. This module has no network client, database connection,
 * or persistence path. Source text is passed ephemerally and is never logged or stored here.
 */
export async function extractCommitmentProposals(
  provider: ExtractionProvider,
  sourceText: string,
  workspaceOwners: readonly WorkspaceOwner[],
): Promise<ExtractionValidationResult> {
  if (sourceText.length > MAX_EXTRACTION_SOURCE_CHARS) {
    throw new ExtractionSourceTooLargeError();
  }

  if (sourceText.trim().length === 0) {
    return {
      status: 'ready-for-review',
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      commitments: [],
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('Extraction provider timeout.'));
      }, EXTRACTION_PROVIDER_TIMEOUT_MS);
    });
    const rawOutput = await Promise.race([
      provider.extract({
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        sourceText,
        sourceTextTrust: 'UNTRUSTED_EXTERNAL_CONTENT',
        untrustedSourceInstruction: EXTRACTION_UNTRUSTED_SOURCE_INSTRUCTION,
        signal: controller.signal,
      }),
      timeout,
    ]);
    return validateAndResolveExtraction(sourceText, rawOutput, workspaceOwners);
  } catch {
    return {
      status: 'provider-failed',
      errorCode: timedOut ? 'EXTRACTION_PROVIDER_TIMEOUT' : 'EXTRACTION_PROVIDER_FAILURE',
      commitments: [],
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    controller.abort();
  }
}
