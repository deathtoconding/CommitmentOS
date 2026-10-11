import { and, eq } from 'drizzle-orm';
import { getAuthenticatedSession } from '../auth/session';
import { database } from '../db/client';
import { workspace, workspaceMember, type WorkspaceRole } from '../db/schema';
import {
  forbiddenResponse,
  internalErrorResponse,
  notFoundResponse,
  unauthenticatedResponse,
} from './responses';

type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof getAuthenticatedSession>>>;

export type AuthorizationResult<T> =
  { authorized: true; value: T } | { authorized: false; response: Response };

export type WorkspaceAccessContext = {
  session: AuthenticatedSession;
  membership: {
    id: string;
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    createdAt: Date;
  };
  workspace: {
    id: string;
    name: string;
    createdAt: Date;
  };
};

export async function requireSession(
  headers: Headers,
): Promise<AuthorizationResult<AuthenticatedSession>> {
  try {
    const currentSession = await getAuthenticatedSession(headers);
    if (!currentSession) {
      return { authorized: false, response: unauthenticatedResponse() };
    }

    return { authorized: true, value: currentSession };
  } catch {
    return { authorized: false, response: internalErrorResponse() };
  }
}

export async function requireWorkspaceMember(
  headers: Headers,
  workspaceId: string,
): Promise<AuthorizationResult<WorkspaceAccessContext>> {
  const sessionResult = await requireSession(headers);
  if (!sessionResult.authorized) {
    return sessionResult;
  }

  try {
    const [access] = await database
      .select({
        membership: {
          id: workspaceMember.id,
          workspaceId: workspaceMember.workspaceId,
          userId: workspaceMember.userId,
          role: workspaceMember.role,
          createdAt: workspaceMember.createdAt,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.createdAt,
        },
      })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, sessionResult.value.user.id),
        ),
      )
      .limit(1);

    if (!access) {
      return { authorized: false, response: notFoundResponse() };
    }

    return {
      authorized: true,
      value: { session: sessionResult.value, ...access },
    };
  } catch {
    return { authorized: false, response: internalErrorResponse() };
  }
}

export async function requireWorkspaceRole(
  headers: Headers,
  workspaceId: string,
  allowedRoles: readonly WorkspaceRole[],
): Promise<AuthorizationResult<WorkspaceAccessContext>> {
  const membershipResult = await requireWorkspaceMember(headers, workspaceId);
  if (!membershipResult.authorized) {
    return membershipResult;
  }

  if (!allowedRoles.includes(membershipResult.value.membership.role)) {
    return { authorized: false, response: forbiddenResponse() };
  }

  return membershipResult;
}
