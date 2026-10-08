import { z } from 'zod';
import { SOURCE_MESSAGE_PROVIDERS } from './model';

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

const opaqueIdentifier = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) =>
        value.trim().length > 0 && value === value.trim() && !containsControlCharacters(value),
      'Identifier must be nonblank and contain no surrounding whitespace or control characters.',
    );

const nullableProviderTimestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * Accepts only provider identity facts supplied by a trusted connector. IDs remain opaque and
 * case-sensitive; this schema never trims, lowercases, or otherwise rewrites them.
 */
export const sourceMessageIdentitySchema = z
  .object({
    provider: z.enum(SOURCE_MESSAGE_PROVIDERS),
    providerAccountId: opaqueIdentifier(1_024),
    providerMessageId: opaqueIdentifier(2_048),
    providerTimestamp: nullableProviderTimestamp,
  })
  .strict();

export type SourceMessageIdentityInput = z.input<typeof sourceMessageIdentitySchema>;
export type NormalizedSourceMessageIdentity = z.output<typeof sourceMessageIdentitySchema>;
