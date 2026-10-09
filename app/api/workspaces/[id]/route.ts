import { requireWorkspaceMember } from '@/workspaces/authorization';
import { workspaceResponse } from '@/workspaces/responses';

type WorkspaceRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: WorkspaceRouteContext): Promise<Response> {
  const { id } = await context.params;
  const access = await requireWorkspaceMember(request.headers, id);
  if (!access.authorized) {
    return access.response;
  }

  return workspaceResponse({
    workspace: {
      ...access.value.workspace,
      role: access.value.membership.role,
    },
  });
}
