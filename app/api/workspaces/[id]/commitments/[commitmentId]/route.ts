import { updateCommitmentSchema } from '@/commitments/schemas';
import { getWorkspaceCommitment, updateWorkspaceCommitment } from '@/commitments/service';
import { requireWorkspaceMember } from '@/workspaces/authorization';
import {
  internalErrorResponse,
  invalidRequestResponse,
  notFoundResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceCommitmentRouteContext = {
  params: Promise<{ id: string; commitmentId: string }>;
};

export async function GET(
  request: Request,
  context: WorkspaceCommitmentRouteContext,
): Promise<Response> {
  const { id, commitmentId } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  try {
    const record = await getWorkspaceCommitment(access.value.workspace.id, commitmentId);
    if (!record) {
      return notFoundResponse();
    }

    return workspaceResponse({ commitment: record });
  } catch {
    return internalErrorResponse();
  }
}

export async function PATCH(
  request: Request,
  context: WorkspaceCommitmentRouteContext,
): Promise<Response> {
  const { id, commitmentId } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalidRequestResponse();
  }

  const parsed = updateCommitmentSchema.safeParse(payload);
  if (!parsed.success) {
    return invalidRequestResponse();
  }

  try {
    const result = await updateWorkspaceCommitment(
      access.value.workspace.id,
      access.value.session.user.id,
      commitmentId,
      parsed.data,
    );

    if (result.status === 'updated') {
      return workspaceResponse({ commitment: result.commitment });
    }
    if (result.status === 'owner-not-member') {
      return workspaceResponse({ error: 'INVALID_OWNER' }, 400);
    }
    if (result.status === 'transition-rejected') {
      return workspaceResponse({ error: result.code }, 409);
    }
    return notFoundResponse();
  } catch {
    return internalErrorResponse();
  }
}
