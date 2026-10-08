import { z } from 'zod';

export const JOB_KINDS = ['PLATFORM_PROBE'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_FAILURE_CLASSES = [
  'TRANSIENT',
  'RATE_LIMITED',
  'TIMEOUT',
  'AUTHENTICATION',
  'PERMANENT',
  'UNKNOWN',
] as const;
export type JobFailureClass = (typeof JOB_FAILURE_CLASSES)[number];

const jobPayloadSchemas = {
  PLATFORM_PROBE: z.object({ probeId: z.string().uuid() }).strict(),
} satisfies Record<JobKind, z.ZodType>;

const jobRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(128),
    kind: z.enum(JOB_KINDS),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    correlationId: z.string().uuid().optional(),
    payload: z.unknown(),
  })
  .strict();

export type JobRequest = {
  workspaceId: string;
  kind: JobKind;
  idempotencyKey: string;
  correlationId?: string;
  payload: Record<string, unknown>;
};

export function parseJobRequest(input: unknown): JobRequest {
  const parsed = jobRequestSchema.parse(input);
  const payload = jobPayloadSchemas[parsed.kind].parse(parsed.payload);
  return {
    ...parsed,
    payload,
  };
}

export class ClassifiedJobError extends Error {
  readonly failureClass: JobFailureClass;
  readonly code: string;

  constructor(message: string, failureClass: JobFailureClass, code: string) {
    super(message);
    this.name = 'ClassifiedJobError';
    this.failureClass = failureClass;
    this.code = safeJobErrorCode(code);
  }
}

export class RetryableJobError extends ClassifiedJobError {
  constructor(message: string, code: string) {
    super(message, 'TRANSIENT', code);
    this.name = 'RetryableJobError';
  }
}

export class RateLimitedJobError extends ClassifiedJobError {
  readonly retryAfterMs?: number;

  constructor(message: string, code: string, retryAfterMs?: number) {
    super(message, 'RATE_LIMITED', code);
    this.name = 'RateLimitedJobError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentJobError extends ClassifiedJobError {
  constructor(message: string, code: string) {
    super(message, 'PERMANENT', code);
    this.name = 'PermanentJobError';
  }
}

export type JobFailure = {
  failureClass: JobFailureClass;
  errorCode: string;
  retryable: boolean;
  retryAfterMs?: number;
};

const transientErrorCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKET',
]);

const safeErrorCodes = new Set([
  ...transientErrorCodes,
  'JOB_TIMEOUT',
  'WORKER_LEASE_EXPIRED',
  'WORKSPACE_NOT_FOUND',
  'JOB_HANDLER_UNAVAILABLE',
  'INVALID_QUEUE_MESSAGE',
  'INVALID_PAYLOAD',
  'REDIS_ERROR',
  'TEST_TRANSIENT',
  'TEST_PERMANENT',
]);

export function classifyJobFailure(error: unknown): JobFailure {
  if (error instanceof ClassifiedJobError) {
    return {
      failureClass: error.failureClass,
      errorCode: error.code,
      retryable:
        error.failureClass === 'TRANSIENT' ||
        error.failureClass === 'RATE_LIMITED' ||
        error.failureClass === 'TIMEOUT',
      ...(error instanceof RateLimitedJobError && error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { failureClass: 'TIMEOUT', errorCode: 'JOB_TIMEOUT', retryable: true };
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    const codeStatus = /^HTTP_(\d{3})$/.exec(code)?.[1];
    const status = Number(candidate.status ?? candidate.statusCode ?? codeStatus);
    if (status === 429) {
      return { failureClass: 'RATE_LIMITED', errorCode: 'HTTP_429', retryable: true };
    }
    if (status === 408) {
      return { failureClass: 'TIMEOUT', errorCode: 'HTTP_408', retryable: true };
    }
    if (status === 401 || status === 403) {
      return { failureClass: 'AUTHENTICATION', errorCode: `HTTP_${status}`, retryable: false };
    }
    if (
      (status >= 500 && status <= 599) ||
      transientErrorCodes.has(code) ||
      code.startsWith('08')
    ) {
      return {
        failureClass: 'TRANSIENT',
        errorCode: safeJobErrorCode(code || `HTTP_${status}`),
        retryable: true,
      };
    }
    if (status >= 400 && status <= 499) {
      return {
        failureClass: 'PERMANENT',
        errorCode: safeJobErrorCode(code || `HTTP_${status}`),
        retryable: false,
      };
    }
    const sanitizedCode = safeJobErrorCode(code);
    if (sanitizedCode !== 'UNKNOWN_ERROR') {
      return { failureClass: 'UNKNOWN', errorCode: sanitizedCode, retryable: false };
    }
  }

  return { failureClass: 'UNKNOWN', errorCode: 'UNKNOWN_ERROR', retryable: false };
}

export function safeJobErrorCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (safeErrorCodes.has(normalized) || /^HTTP_[45]\d{2}$/.test(normalized)) return normalized;
  if (/^[0-9A-Z]{5}$/.test(normalized)) return normalized;
  return 'UNKNOWN_ERROR';
}

export function computeRetryDelay(attempt: number, baseDelayMs: number): number {
  const boundedAttempt = Math.max(1, Math.min(16, Math.floor(attempt)));
  return Math.min(60_000, baseDelayMs * 2 ** (boundedAttempt - 1));
}
