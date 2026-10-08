import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { database } from '../db/client';
import { sourceMessage } from '../db/schema';
import type { SourceMessage } from './model';
import { sourceMessageIdentitySchema, type SourceMessageIdentityInput } from './schemas';

type SourceMessageTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

export class SourceMessageProviderTimestampConflictError extends Error {
  constructor() {
    super('A source message identity was received with conflicting provider timestamps.');
    this.name = 'SourceMessageProviderTimestampConflictError';
  }
}

async function getExistingSourceMessage(
  transaction: SourceMessageTransaction,
  workspaceId: string,
  identity: ReturnType<typeof sourceMessageIdentitySchema.parse>,
): Promise<SourceMessage | null> {
  const [record] = await transaction
    .select()
    .from(sourceMessage)
    .where(
      and(
        eq(sourceMessage.workspaceId, workspaceId),
        eq(sourceMessage.provider, identity.provider),
        eq(sourceMessage.providerAccountId, identity.providerAccountId),
        eq(sourceMessage.providerMessageId, identity.providerMessageId),
      ),
    )
    .limit(1)
    .for('update');

  return record ?? null;
}

/**
 * Persists provider identity metadata from a trusted connector. PostgreSQL's composite unique
 * constraint makes concurrent deliveries idempotent within, but never across, workspaces.
 */
export async function recordSourceMessage(
  workspaceId: string,
  input: SourceMessageIdentityInput,
): Promise<{ status: 'created' | 'existing'; sourceMessage: SourceMessage }> {
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim() || workspaceId.length > 255) {
    throw new TypeError('A valid workspace identifier is required.');
  }

  const identity = sourceMessageIdentitySchema.parse(input);

  return database.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(sourceMessage)
      .values({
        id: randomUUID(),
        workspaceId,
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        providerMessageId: identity.providerMessageId,
        providerTimestamp: identity.providerTimestamp,
      })
      .onConflictDoNothing({
        target: [
          sourceMessage.workspaceId,
          sourceMessage.provider,
          sourceMessage.providerAccountId,
          sourceMessage.providerMessageId,
        ],
      })
      .returning();

    if (created) {
      return { status: 'created', sourceMessage: created };
    }

    const existing = await getExistingSourceMessage(transaction, workspaceId, identity);
    if (!existing) {
      // A conflicting identity can disappear only through an out-of-band database write.
      throw new Error('The existing source message could not be reloaded after deduplication.');
    }

    if (
      existing.providerTimestamp !== null &&
      identity.providerTimestamp !== null &&
      existing.providerTimestamp.getTime() !== identity.providerTimestamp.getTime()
    ) {
      throw new SourceMessageProviderTimestampConflictError();
    }

    if (existing.providerTimestamp === null && identity.providerTimestamp !== null) {
      const [enriched] = await transaction
        .update(sourceMessage)
        .set({ providerTimestamp: identity.providerTimestamp })
        .where(eq(sourceMessage.id, existing.id))
        .returning();
      if (!enriched) {
        throw new Error('The source message disappeared while applying provider metadata.');
      }
      return { status: 'existing', sourceMessage: enriched };
    }

    return { status: 'existing', sourceMessage: existing };
  });
}
