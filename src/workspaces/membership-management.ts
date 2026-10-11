import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { database } from '../db/client';
import {
  user,
  workspace,
  workspaceAuditEvent,
  workspaceMember,
  type WorkspaceRole,
} from '../db/schema';
import {
  workspaceMemberAddedAuditEvent,
  workspaceMemberRemovedAuditEvent,
  workspaceMemberRoleChangedAuditEvent,
  type WorkspaceAuditEventDraft,
} from './audit-model';

type WorkspaceTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

type OwnerMutationFailure =
  | { status: 'workspace-not-found' }
  | { status: 'actor-not-member' }
  | { status: 'actor-not-owner' };

export type WorkspaceMemberRecord = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  createdAt: Date;
};

export type AddWorkspaceMemberResult =
  | OwnerMutationFailure
  | { status: 'user-not-found' }
  | { status: 'already-member' }
  | { status: 'created'; member: WorkspaceMemberRecord };

export type UpdateWorkspaceMemberRoleResult =
  | OwnerMutationFailure
  | { status: 'member-not-found' }
  | { status: 'final-owner' }
  | { status: 'updated'; member: WorkspaceMemberRecord };

export type RemoveWorkspaceMemberResult =
  | OwnerMutationFailure
  | { status: 'member-not-found' }
  | { status: 'final-owner' }
  | { status: 'removed'; memberId: string };

async function lockWorkspaceAndRequireOwner(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  actorUserId: string,
): Promise<OwnerMutationFailure | null> {
  const [lockedWorkspace] = await transaction
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for('update');

  if (!lockedWorkspace) {
    return { status: 'workspace-not-found' };
  }

  const [actorMembership] = await transaction
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(
      and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, actorUserId)),
    )
    .limit(1);

  if (!actorMembership) {
    return { status: 'actor-not-member' };
  }

  if (actorMembership.role !== 'OWNER') {
    return { status: 'actor-not-owner' };
  }

  return null;
}

async function countOwners(
  transaction: WorkspaceTransaction,
  workspaceId: string,
): Promise<number> {
  const [ownerCount] = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, 'OWNER')));

  return ownerCount?.count ?? 0;
}

async function persistWorkspaceAuditEvent(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  actorUserId: string,
  event: WorkspaceAuditEventDraft,
): Promise<void> {
  await transaction.insert(workspaceAuditEvent).values({
    id: randomUUID(),
    workspaceId,
    actorUserId,
    ...event,
    occurredAt: new Date(),
  });
}

export async function addWorkspaceMember(
  workspaceId: string,
  actorUserId: string,
  email: string,
): Promise<AddWorkspaceMemberResult> {
  return database.transaction(async (transaction) => {
    const ownerFailure = await lockWorkspaceAndRequireOwner(transaction, workspaceId, actorUserId);
    if (ownerFailure) {
      return ownerFailure;
    }

    const [targetUser] = await transaction
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(and(eq(user.email, email), eq(user.emailVerified, true)))
      .limit(1);

    if (!targetUser) {
      // Do not enroll an account until its mailbox identity has been verified.
      return { status: 'user-not-found' };
    }

    const [membership] = await transaction
      .insert(workspaceMember)
      .values({
        id: randomUUID(),
        workspaceId,
        userId: targetUser.id,
        role: 'MEMBER',
      })
      .onConflictDoNothing({ target: [workspaceMember.workspaceId, workspaceMember.userId] })
      .returning({
        id: workspaceMember.id,
        userId: workspaceMember.userId,
        role: workspaceMember.role,
        createdAt: workspaceMember.createdAt,
      });

    if (!membership) {
      return { status: 'already-member' };
    }

    await persistWorkspaceAuditEvent(
      transaction,
      workspaceId,
      actorUserId,
      workspaceMemberAddedAuditEvent(targetUser.id),
    );

    return {
      status: 'created',
      member: { ...targetUser, ...membership },
    };
  });
}

export async function updateWorkspaceMemberRole(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  role: WorkspaceRole,
): Promise<UpdateWorkspaceMemberRoleResult> {
  return database.transaction(async (transaction) => {
    const ownerFailure = await lockWorkspaceAndRequireOwner(transaction, workspaceId, actorUserId);
    if (ownerFailure) {
      return ownerFailure;
    }

    const [targetMembership] = await transaction
      .select({
        id: workspaceMember.id,
        userId: workspaceMember.userId,
        name: user.name,
        email: user.email,
        role: workspaceMember.role,
        createdAt: workspaceMember.createdAt,
      })
      .from(workspaceMember)
      .innerJoin(user, eq(workspaceMember.userId, user.id))
      .where(
        and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetUserId)),
      )
      .limit(1);

    if (!targetMembership) {
      return { status: 'member-not-found' };
    }

    if (targetMembership.role === role) {
      return { status: 'updated', member: targetMembership };
    }

    if (targetMembership.role === 'OWNER' && role === 'MEMBER') {
      const ownerCount = await countOwners(transaction, workspaceId);
      if (ownerCount <= 1) {
        return { status: 'final-owner' };
      }
    }

    const [updatedMembership] = await transaction
      .update(workspaceMember)
      .set({ role })
      .where(
        and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetUserId)),
      )
      .returning({ role: workspaceMember.role });

    if (!updatedMembership) {
      return { status: 'member-not-found' };
    }

    await persistWorkspaceAuditEvent(
      transaction,
      workspaceId,
      actorUserId,
      workspaceMemberRoleChangedAuditEvent(targetUserId, targetMembership.role, role),
    );

    return {
      status: 'updated',
      member: { ...targetMembership, role: updatedMembership.role },
    };
  });
}

export async function removeWorkspaceMember(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<RemoveWorkspaceMemberResult> {
  return database.transaction(async (transaction) => {
    const ownerFailure = await lockWorkspaceAndRequireOwner(transaction, workspaceId, actorUserId);
    if (ownerFailure) {
      return ownerFailure;
    }

    const [targetMembership] = await transaction
      .select({ id: workspaceMember.id, role: workspaceMember.role })
      .from(workspaceMember)
      .where(
        and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetUserId)),
      )
      .limit(1);

    if (!targetMembership) {
      return { status: 'member-not-found' };
    }

    if (targetMembership.role === 'OWNER' && (await countOwners(transaction, workspaceId)) <= 1) {
      return { status: 'final-owner' };
    }

    const [removedMembership] = await transaction
      .delete(workspaceMember)
      .where(
        and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetUserId)),
      )
      .returning({ id: workspaceMember.id });

    if (!removedMembership) {
      return { status: 'member-not-found' };
    }

    await persistWorkspaceAuditEvent(
      transaction,
      workspaceId,
      actorUserId,
      workspaceMemberRemovedAuditEvent(targetUserId, targetMembership.role),
    );

    return { status: 'removed', memberId: removedMembership.id };
  });
}
