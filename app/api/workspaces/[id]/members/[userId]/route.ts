import { requireWorkspaceRole } from '@/workspaces/authorization';
import {
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from '@/workspaces/membership-management';
import { readJsonRequestBody } from '@/http/request-body';
import { payloadTooLargeResponse } from '@/http/responses';
import { changeWorkspaceMemberRoleSchema } from '@/workspaces/schemas';
import {
  forbiddenResponse,
  internalErrorResponse,
  invalidRequestResponse,
  notFoundResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceMemberRouteContext = {
  params: Promise<{ id: string; userId: string }>;
};

export async function PATCH(
  request: Request,
  context: WorkspaceMemberRouteContext,
): Promise<Response> {
  const { id, userId } = await context.params;
  const access = await requireWorkspaceRole(request.headers, id, ['OWNER']);
  if (!access.authorized) {
    return access.response;
  }

  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return body.reason === 'too-large' ? payloadTooLargeResponse() : invalidRequestResponse();
  }

  const parsed = changeWorkspaceMemberRoleSchema.safeParse(body.value);
  if (!parsed.success) {
    return invalidRequestResponse();
  }

  try {
    const result = await updateWorkspaceMemberRole(
      id,
      access.value.session.user.id,
      userId,
      parsed.data.role,
    );
    if (result.status === 'updated') {
      return workspaceResponse({ member: result.member });
    }
    if (result.status === 'final-owner') {
      return workspaceResponse({ error: 'FINAL_OWNER_REQUIRED' }, 409);
    }
    if (result.status === 'actor-not-owner') {
      return forbiddenResponse();
    }
    return notFoundResponse();
  } catch {
    return internalErrorResponse();
  }
}

export async function DELETE(
  request: Request,
  context: WorkspaceMemberRouteContext,
): Promise<Response> {
  const { id, userId } = await context.params;
  const access = await requireWorkspaceRole(request.headers, id, ['OWNER']);
  if (!access.authorized) {
    return access.response;
  }

  try {
    const result = await removeWorkspaceMember(id, access.value.session.user.id, userId);
    if (result.status === 'removed') {
      return workspaceResponse({ removed: true, membershipId: result.memberId });
    }
    if (result.status === 'final-owner') {
      return workspaceResponse({ error: 'FINAL_OWNER_REQUIRED' }, 409);
    }
    if (result.status === 'actor-not-owner') {
      return forbiddenResponse();
    }
    return notFoundResponse();
  } catch {
    return internalErrorResponse();
  }
}
