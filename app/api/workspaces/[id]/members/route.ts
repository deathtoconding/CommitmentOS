import { asc, eq } from 'drizzle-orm';
import { database } from '@/db/client';
import { user, workspaceMember } from '@/db/schema';
import { addWorkspaceMember } from '@/workspaces/membership-management';
import { requireWorkspaceMember, requireWorkspaceRole } from '@/workspaces/authorization';
import { readJsonRequestBody } from '@/http/request-body';
import { payloadTooLargeResponse } from '@/http/responses';
import { addWorkspaceMemberSchema } from '@/workspaces/schemas';
import {
  forbiddenResponse,
  internalErrorResponse,
  invalidRequestResponse,
  notFoundResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceMembersRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: Request,
  context: WorkspaceMembersRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  try {
    const members = await database
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
      .where(eq(workspaceMember.workspaceId, access.value.workspace.id))
      .orderBy(asc(user.name), asc(user.id));

    return workspaceResponse({ members });
  } catch {
    return internalErrorResponse();
  }
}

export async function POST(
  request: Request,
  context: WorkspaceMembersRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const access = await requireWorkspaceRole(request.headers, id, ['OWNER']);
  if (!access.authorized) {
    return access.response;
  }

  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return body.reason === 'too-large' ? payloadTooLargeResponse() : invalidRequestResponse();
  }

  const parsed = addWorkspaceMemberSchema.safeParse(body.value);
  if (!parsed.success) {
    return invalidRequestResponse();
  }

  try {
    const result = await addWorkspaceMember(id, access.value.session.user.id, parsed.data.email);
    if (result.status === 'created') {
      return workspaceResponse({ member: result.member }, 201);
    }
    if (result.status === 'already-member') {
      return workspaceResponse({ error: 'ALREADY_MEMBER' }, 409);
    }
    if (result.status === 'user-not-found') {
      return workspaceResponse({ error: 'USER_NOT_FOUND' }, 404);
    }
    if (result.status === 'actor-not-owner') {
      return forbiddenResponse();
    }
    return notFoundResponse();
  } catch {
    return internalErrorResponse();
  }
}
