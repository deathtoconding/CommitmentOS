import { createCommitmentSchema } from '@/commitments/schemas';
import { readJsonRequestBody } from '@/http/request-body';
import { payloadTooLargeResponse } from '@/http/responses';
import { createWorkspaceCommitment, listWorkspaceCommitments } from '@/commitments/service';
import { requireWorkspaceMember } from '@/workspaces/authorization';
import {
  internalErrorResponse,
  invalidRequestResponse,
  notFoundResponse,
  workspaceResponse,
} from '@/workspaces/responses';

type WorkspaceCommitmentsRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: Request,
  context: WorkspaceCommitmentsRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  try {
    const commitments = await listWorkspaceCommitments(access.value.workspace.id);
    return workspaceResponse({ commitments });
  } catch {
    return internalErrorResponse();
  }
}

export async function POST(
  request: Request,
  context: WorkspaceCommitmentsRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return body.reason === 'too-large' ? payloadTooLargeResponse() : invalidRequestResponse();
  }

  const parsed = createCommitmentSchema.safeParse(body.value);
  if (!parsed.success) {
    return invalidRequestResponse();
  }

  try {
    const result = await createWorkspaceCommitment(
      access.value.workspace.id,
      access.value.session.user.id,
      parsed.data,
    );

    if (result.status === 'created') {
      return workspaceResponse({ commitment: result.commitment }, 201);
    }
    if (result.status === 'owner-not-member') {
      return workspaceResponse({ error: 'INVALID_OWNER' }, 400);
    }
    return notFoundResponse();
  } catch {
    return internalErrorResponse();
  }
}
