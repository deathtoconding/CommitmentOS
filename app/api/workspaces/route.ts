import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import { getAuthenticatedSession } from '@/auth/session';
import { database } from '@/db/client';
import { workspace, workspaceMember } from '@/db/schema';
import { createWorkspaceSchema } from '@/workspaces/schemas';
import {
  internalErrorResponse,
  invalidRequestResponse,
  unauthenticatedResponse,
  workspaceResponse,
} from '@/workspaces/responses';

export async function GET(request: Request): Promise<Response> {
  const currentSession = await getAuthenticatedSession(request.headers);
  if (!currentSession) {
    return unauthenticatedResponse();
  }

  try {
    const workspaces = await database
      .select({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        role: workspaceMember.role,
      })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspaceMember.workspaceId, workspace.id))
      .where(eq(workspaceMember.userId, currentSession.user.id))
      .orderBy(desc(workspace.createdAt), asc(workspace.id));

    return workspaceResponse({ workspaces });
  } catch {
    return internalErrorResponse();
  }
}

export async function POST(request: Request): Promise<Response> {
  const currentSession = await getAuthenticatedSession(request.headers);
  if (!currentSession) {
    return unauthenticatedResponse();
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalidRequestResponse();
  }

  const parsed = createWorkspaceSchema.safeParse(payload);
  if (!parsed.success) {
    return invalidRequestResponse();
  }

  try {
    const createdWorkspace = await database.transaction(async (transaction) => {
      const [newWorkspace] = await transaction
        .insert(workspace)
        .values({ id: randomUUID(), name: parsed.data.name })
        .returning({
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.createdAt,
        });

      if (!newWorkspace) {
        throw new Error('Workspace insert returned no row.');
      }

      await transaction.insert(workspaceMember).values({
        id: randomUUID(),
        workspaceId: newWorkspace.id,
        userId: currentSession.user.id,
        role: 'OWNER',
      });

      return { ...newWorkspace, role: 'OWNER' as const };
    });

    return workspaceResponse({ workspace: createdWorkspace }, 201);
  } catch {
    return internalErrorResponse();
  }
}
