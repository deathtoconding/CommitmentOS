import { and, eq } from 'drizzle-orm';
import { getAuthenticatedSession } from '@/auth/session';
import { database } from '@/db/client';
import { workspace, workspaceMember } from '@/db/schema';
import {
  internalErrorResponse,
  notFoundResponse,
  unauthenticatedResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: WorkspaceRouteContext): Promise<Response> {
  const currentSession = await getAuthenticatedSession(request.headers);
  if (!currentSession) {
    return unauthenticatedResponse();
  }

  const { id } = await context.params;
  try {
    const [accessibleWorkspace] = await database
      .select({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        role: workspaceMember.role,
      })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
      .where(
        and(
          eq(workspaceMember.workspaceId, id),
          eq(workspaceMember.userId, currentSession.user.id),
        ),
      )
      .limit(1);

    if (!accessibleWorkspace) {
      return notFoundResponse();
    }

    return workspaceResponse({ workspace: accessibleWorkspace });
  } catch {
    return internalErrorResponse();
  }
}
