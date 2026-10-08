import { requireWorkspaceRole } from '@/workspaces/authorization';
import {
  removeWorkspaceMember,
  updateWorkspaceMemberRole,
} from '@/workspaces/membership-management';
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalidRequestResponse();
  }

  const parsed = changeWorkspaceMemberRoleSchema.safeParse(payload);
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
