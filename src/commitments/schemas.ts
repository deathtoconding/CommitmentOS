import { z } from 'zod';
import { COMMITMENT_STATUSES } from './model';

const commitmentTextSchema = z.string().trim().min(1).max(5_000);
const normalizedActionSchema = z.string().trim().min(1).max(5_000);
const nullableOwnerUserIdSchema = z.string().trim().min(1).max(255).nullable().optional();
const nullableSourceMessageIdSchema = z.string().trim().min(1).max(2_048).nullable().optional();
const nullableCounterpartyNameSchema = z.string().trim().min(1).max(255).nullable().optional();
const nullableCounterpartyEmailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase())
  .nullable()
  .optional();
const nullableDueAtSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .nullable()
  .optional();
const nullableDueTimezoneSchema = z.string().trim().min(1).max(100).nullable().optional();
const nullableConfidenceScoreSchema = z.number().finite().min(0).max(1).nullable().optional();
const nullableSourceExcerptSchema = z.string().max(10_000).nullable().optional();
const nullableCompletionEvidenceSchema = z.string().max(10_000).nullable().optional();

const commitmentDetails = {
  ownerUserId: nullableOwnerUserIdSchema,
  sourceMessageId: nullableSourceMessageIdSchema,
  counterpartyName: nullableCounterpartyNameSchema,
  counterpartyEmail: nullableCounterpartyEmailSchema,
  dueAt: nullableDueAtSchema,
  dueTimezone: nullableDueTimezoneSchema,
  confidenceScore: nullableConfidenceScoreSchema,
  sourceExcerpt: nullableSourceExcerptSchema,
};

export const createCommitmentSchema = z
  .object({
    commitmentText: commitmentTextSchema,
    normalizedAction: normalizedActionSchema,
    ...commitmentDetails,
  })
  .strict();

export const commitmentAuditEventCursorSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const commitmentAuditEventLimitSchema = z.coerce.number().int().min(1).max(100);

export const updateCommitmentSchema = z
  .object({
    commitmentText: commitmentTextSchema.optional(),
    normalizedAction: normalizedActionSchema.optional(),
    ...commitmentDetails,
    completionEvidence: nullableCompletionEvidenceSchema,
    status: z.enum(COMMITMENT_STATUSES).optional(),
    completionSignal: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasUpdate = Object.keys(value).some((key) => key !== 'completionSignal');
    if (!hasUpdate) {
      context.addIssue({ code: 'custom', message: 'At least one update field is required.' });
    }

    if (value.completionSignal !== undefined && value.status !== 'COMPLETED') {
      context.addIssue({
        code: 'custom',
        path: ['completionSignal'],
        message: 'A completion signal is only valid when transitioning to COMPLETED.',
      });
    }
  });

export type CreateCommitmentInput = z.infer<typeof createCommitmentSchema>;
export type UpdateCommitmentInput = z.infer<typeof updateCommitmentSchema>;
export type CommitmentAuditEventCursorInput = z.infer<typeof commitmentAuditEventCursorSchema>;
export type CommitmentAuditEventLimitInput = z.infer<typeof commitmentAuditEventLimitSchema>;
