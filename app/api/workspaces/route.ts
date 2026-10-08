import { randomUUID } from 'node:crypto';
import { database } from '@/db/client';
import { workspace, workspaceMember } from '@/db/schema';
import { listUserWorkspaces } from '@/workspaces/queries';
import { requireSession } from '@/workspaces/authorization';
import { createWorkspaceSchema } from '@/workspaces/schemas';
import {
  internalErrorResponse,
  invalidRequestResponse,
  workspaceResponse,
} from '@/workspaces/responses';

export async function GET(request: Request): Promise<Response> {
  const sessionResult = await requireSession(request.headers);
  if (!sessionResult.authorized) {
    return sessionResult.response;
  }

  try {
    const workspaces = await listUserWorkspaces(sessionResult.value.user.id);
    return workspaceResponse({ workspaces });
  } catch {
    return internalErrorResponse();
  }
}

export async function POST(request: Request): Promise<Response> {
  const sessionResult = await requireSession(request.headers);
  if (!sessionResult.authorized) {
    return sessionResult.response;
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
        userId: sessionResult.value.user.id,
        role: 'OWNER',
      });

      return { ...newWorkspace, role: 'OWNER' as const };
    });

    return workspaceResponse({ workspace: createdWorkspace }, 201);
  } catch {
    return internalErrorResponse();
  }
}
