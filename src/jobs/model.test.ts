import { describe, expect, it } from 'vitest';
import {
  classifyJobFailure,
  computeRetryDelay,
  PermanentJobError,
  RateLimitedJobError,
  RetryableJobError,
  parseJobRequest,
  safeJobErrorCode,
} from './model';

const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
const probeId = '123e4567-e89b-42d3-a456-426614174001';

const validJob = {
  workspaceId,
  kind: 'PLATFORM_PROBE',
  idempotencyKey: 'probe:nightly:2026-10-09',
  payload: { probeId },
};

describe('background job contracts', () => {
  it('validates allowed job payloads and creates correlation identifiers later', () => {
    expect(parseJobRequest(validJob)).toEqual(validJob);
    expect(parseJobRequest({ ...validJob, correlationId: probeId })).toEqual({
      ...validJob,
      correlationId: probeId,
    });
  });

  it('rejects unknown fields, unsafe idempotency keys, and malformed payloads', () => {
    expect(() => parseJobRequest({ ...validJob, payload: { probeId, token: 'secret' } })).toThrow();
    expect(() => parseJobRequest({ ...validJob, idempotencyKey: 'email@customer.test' })).toThrow();
    expect(() => parseJobRequest({ ...validJob, unknown: true })).toThrow();
  });

  it('classifies retryable, rate-limited, timeout, authentication, and permanent failures', () => {
    expect(classifyJobFailure(new RetryableJobError('network reset', 'ECONNRESET'))).toMatchObject({
      failureClass: 'TRANSIENT',
      errorCode: 'ECONNRESET',
      retryable: true,
    });
    expect(
      classifyJobFailure(new RateLimitedJobError('provider limit', 'HTTP_429', 2_000)),
    ).toEqual({
      failureClass: 'RATE_LIMITED',
      errorCode: 'HTTP_429',
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(
      classifyJobFailure(Object.assign(new Error('deadline'), { name: 'TimeoutError' })),
    ).toMatchObject({
      failureClass: 'TIMEOUT',
      retryable: true,
    });
    expect(classifyJobFailure({ status: 401 })).toMatchObject({
      failureClass: 'AUTHENTICATION',
      retryable: false,
    });
    expect(
      classifyJobFailure(new PermanentJobError('invalid input', 'INVALID_PAYLOAD')),
    ).toMatchObject({
      failureClass: 'PERMANENT',
      errorCode: 'INVALID_PAYLOAD',
      retryable: false,
    });
    expect(classifyJobFailure(new Error('unclassified'))).toMatchObject({
      failureClass: 'UNKNOWN',
      errorCode: 'UNKNOWN_ERROR',
      retryable: false,
    });
  });

  it('redacts unsafe provider error codes and bounds exponential retry delay', () => {
    expect(safeJobErrorCode('api-token-secret')).toBe('UNKNOWN_ERROR');
    expect(safeJobErrorCode('JWTSECRET1234')).toBe('UNKNOWN_ERROR');
    expect(classifyJobFailure({ code: 'HTTP_429' })).toMatchObject({
      failureClass: 'RATE_LIMITED',
      errorCode: 'HTTP_429',
      retryable: true,
    });
    expect(classifyJobFailure({ code: '08006' })).toMatchObject({
      failureClass: 'TRANSIENT',
      errorCode: '08006',
      retryable: true,
    });
    expect(computeRetryDelay(1, 1_000)).toBe(1_000);
    expect(computeRetryDelay(3, 1_000)).toBe(4_000);
    expect(computeRetryDelay(12, 10_000)).toBe(60_000);
  });
});
