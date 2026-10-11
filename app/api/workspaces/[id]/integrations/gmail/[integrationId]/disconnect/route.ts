import { database } from '@/db/client';
import {
  gmailApiError,
  gmailIntegrationRedirect,
  isSameOriginMutation,
} from '@/integrations/gmail/http';
import { getIntegrationEncryptionKey } from '@/integrations/gmail/environment';
import {
  createGmailIntegrationService,
  parseGmailStoredCredentials,
} from '@/integrations/gmail/service-core';
import { revokeGmailToken } from '@/integrations/gmail/provider';
import { requireWorkspaceRole } from '@/workspaces/authorization';

type RouteContext = { params: Promise<{ id: string; integrationId: string }> };
const gmailIntegrationService = createGmailIntegrationService(database);

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { id: workspaceId, integrationId } = await context.params;
  const access = await requireWorkspaceRole(request.headers, workspaceId, ['OWNER']);
  if (!access.authorized) return access.response;
  if (!isSameOriginMutation(request)) return gmailApiError('CSRF_REJECTED', 403);

  let encryptionKey: Buffer;
  try {
    encryptionKey = getIntegrationEncryptionKey();
  } catch {
    return gmailApiError('GMAIL_OAUTH_NOT_CONFIGURED', 503);
  }

  let revocation;
  try {
    revocation = await gmailIntegrationService.beginRevocation({
      workspaceId,
      integrationId,
      actorUserId: access.value.session.user.id,
    });
  } catch {
    return gmailApiError('GMAIL_DISCONNECT_UNAVAILABLE', 503);
  }
  if (revocation.status === 'not-found') return gmailApiError('NOT_FOUND', 404);
  if (revocation.status === 'disconnected') {
    return gmailIntegrationRedirect(workspaceId, 'disconnected');
  }

  try {
    const encrypted = revocation.credentialsCiphertext;
    if (!encrypted) throw new Error('Missing encrypted Gmail credentials.');
    const providerAccountId = revocation.providerAccountId;
    if (!providerAccountId) throw new Error('Missing provider account identity.');
    const stored = parseGmailStoredCredentials(
      encrypted,
      encryptionKey,
      `commitmentos:gmail-integration:${workspaceId}:${providerAccountId}`,
    );
    const revoked = await revokeGmailToken(stored.refreshToken);
    if (revoked) {
      await gmailIntegrationService.completeRevocation({
        workspaceId,
        integrationId,
        actorUserId: access.value.session.user.id,
      });
      return gmailIntegrationRedirect(workspaceId, 'disconnected');
    }
  } catch {
    // The integration remains non-syncable in REVOCATION_PENDING until a retry succeeds.
  }

  try {
    await gmailIntegrationService.failRevocation({
      workspaceId,
      integrationId,
      actorUserId: access.value.session.user.id,
    });
  } catch {
    // Never restore a credential to CONNECTED because audit persistence failed.
  }
  return gmailIntegrationRedirect(workspaceId, 'revocation-pending');
}
