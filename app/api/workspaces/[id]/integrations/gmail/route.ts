import { database } from '@/db/client';
import { gmailApiError } from '@/integrations/gmail/http';
import { createGmailIntegrationService } from '@/integrations/gmail/service-core';
import { requireWorkspaceMember } from '@/workspaces/authorization';

type RouteContext = { params: Promise<{ id: string }> };
const gmailIntegrationService = createGmailIntegrationService(database);

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id: workspaceId } = await context.params;
  const access = await requireWorkspaceMember(request.headers, workspaceId);
  if (!access.authorized) return access.response;

  try {
    const integrations = await gmailIntegrationService.list(workspaceId);
    return Response.json({ integrations }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return gmailApiError('GMAIL_INTEGRATIONS_UNAVAILABLE', 503);
  }
}
