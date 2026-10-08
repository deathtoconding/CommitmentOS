import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { database } from '../db/client';
import { commitment, workspaceMember } from '../db/schema';
import type { Commitment } from './model';
import { transitionCommitment } from './lifecycle';
import type { CreateCommitmentInput, UpdateCommitmentInput } from './schemas';

type CommitmentTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

type MembershipCheck = 'member' | 'not-member';

async function hasWorkspaceMembership(
  transaction: CommitmentTransaction,
  workspaceId: string,
  userId: string,
): Promise<MembershipCheck> {
  const [membership] = await transaction
    .select({ id: workspaceMember.id })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .limit(1)
    .for('share');

  return membership ? 'member' : 'not-member';
}

export async function listWorkspaceCommitments(workspaceId: string): Promise<Commitment[]> {
  return database
    .select()
    .from(commitment)
    .where(eq(commitment.workspaceId, workspaceId))
    .orderBy(desc(commitment.createdAt), desc(commitment.id));
}

export async function getWorkspaceCommitment(
  workspaceId: string,
  commitmentId: string,
): Promise<Commitment | null> {
  const [record] = await database
    .select()
    .from(commitment)
    .where(and(eq(commitment.workspaceId, workspaceId), eq(commitment.id, commitmentId)))
    .limit(1);

  return record ?? null;
}

export type CreateWorkspaceCommitmentResult =
  | { status: 'created'; commitment: Commitment }
  | { status: 'actor-not-member' }
  | { status: 'owner-not-member' };

export async function createWorkspaceCommitment(
  workspaceId: string,
  actorUserId: string,
  input: CreateCommitmentInput,
): Promise<CreateWorkspaceCommitmentResult> {
  return database.transaction(async (transaction) => {
    if ((await hasWorkspaceMembership(transaction, workspaceId, actorUserId)) !== 'member') {
      return { status: 'actor-not-member' };
    }

    if (
      input.ownerUserId !== undefined &&
      input.ownerUserId !== null &&
      (await hasWorkspaceMembership(transaction, workspaceId, input.ownerUserId)) !== 'member'
    ) {
      return { status: 'owner-not-member' };
    }

    const [created] = await transaction
      .insert(commitment)
      .values({
        id: randomUUID(),
        workspaceId,
        createdBy: actorUserId,
        commitmentText: input.commitmentText,
        normalizedAction: input.normalizedAction,
        ownerUserId: input.ownerUserId,
        sourceMessageId: input.sourceMessageId,
        counterpartyName: input.counterpartyName,
        counterpartyEmail: input.counterpartyEmail,
        dueAt: input.dueAt,
        dueTimezone: input.dueTimezone,
        confidenceScore: input.confidenceScore,
        sourceExcerpt: input.sourceExcerpt,
      })
      .returning();

    return { status: 'created', commitment: created };
  });
}

export type UpdateWorkspaceCommitmentResult =
  | { status: 'updated'; commitment: Commitment }
  | { status: 'not-found' }
  | { status: 'actor-not-member' }
  | { status: 'owner-not-member' }
  | {
      status: 'transition-rejected';
      code: 'INVALID_TRANSITION' | 'COMPLETION_SIGNAL_REQUIRED';
    };

export async function updateWorkspaceCommitment(
  workspaceId: string,
  actorUserId: string,
  commitmentId: string,
  input: UpdateCommitmentInput,
): Promise<UpdateWorkspaceCommitmentResult> {
  return database.transaction(async (transaction) => {
    if ((await hasWorkspaceMembership(transaction, workspaceId, actorUserId)) !== 'member') {
      return { status: 'actor-not-member' };
    }

    const [current] = await transaction
      .select()
      .from(commitment)
      .where(and(eq(commitment.workspaceId, workspaceId), eq(commitment.id, commitmentId)))
      .limit(1)
      .for('update');

    if (!current) {
      return { status: 'not-found' };
    }

    if (
      input.ownerUserId !== undefined &&
      input.ownerUserId !== null &&
      (await hasWorkspaceMembership(transaction, workspaceId, input.ownerUserId)) !== 'member'
    ) {
      return { status: 'owner-not-member' };
    }

    const { status: targetStatus, completionSignal, ...inputFields } = input;
    const changes = Object.fromEntries(
      Object.entries(inputFields).filter(([, value]) => value !== undefined),
    ) as Partial<Commitment>;
    const occurredAt = new Date();

    let completedAt: Date | null | undefined;
    if (targetStatus !== undefined) {
      const transition = transitionCommitment(current, targetStatus, {
        completionSignal,
        occurredAt,
      });
      if (!transition.ok) {
        return { status: 'transition-rejected', code: transition.code };
      }
      if (targetStatus === 'COMPLETED') {
        completedAt = transition.commitment.completedAt;
      }
    }

    const [updated] = await transaction
      .update(commitment)
      .set({
        ...changes,
        ...(targetStatus !== undefined ? { status: targetStatus } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
        updatedAt: occurredAt,
      })
      .where(and(eq(commitment.workspaceId, workspaceId), eq(commitment.id, commitmentId)))
      .returning();

    if (!updated) {
      return { status: 'not-found' };
    }

    return { status: 'updated', commitment: updated };
  });
}
